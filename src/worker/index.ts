import { loadLocalEnv } from "@/server/loadEnv";
import { runNextScanJob } from "@/server/scanRunner";
import { scheduleDueScanJobs } from "@/server/scheduler";
import {
  getQueueStats,
  listProfiles,
  listScanJobs,
  requeueStaleRunningCandidates
} from "@/server/store";

async function main() {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const profiles = await listProfiles();
  const jobs = await listScanJobs();
  const recovered = await requeueStaleRunningCandidates(0);

  console.log("fetchGithub worker bootstrap");
  console.log(`profiles=${profiles.length} jobs=${jobs.length}`);
  if (recovered.length) {
    console.log(`recovered_running_candidates=${JSON.stringify(recovered)}`);
  }

  while (!stopping) {
    try {
      loadLocalEnv(process.cwd(), { overrideEmpty: true });

      const scheduled = await scheduleDueScanJobs();
      if (scheduled.length) {
        console.log(`scheduled_jobs=${scheduled.map((job) => job.id).join(",")}`);
      }

      const job = await runNextScanJob({
        maxPages: 3,
        maxProfileBatches: 3
      });

      if (job) {
        console.log(
          `job=${job.id} status=${job.status} stage=${job.stage} fetched=${job.fetchedCount}/${job.maxCandidates} processed=${job.processedCount} analyzed=${job.analyzedCount}`
        );
        if (job.statusReason || job.errorMessage) {
          console.log(`reason=${job.statusReason ?? job.errorMessage}`);
        }
        if (["retry_later", "throttled", "paused_by_memory"].includes(job.status)) {
          await delay(10_000);
        }
        continue;
      }

      const queueStats = await getQueueStats();
      console.log(`queue_stats=${JSON.stringify(queueStats)}`);
      await delay(3000);
    } catch (error) {
      console.error("worker_loop_error", error);
      if (!stopping) {
        await delay(10_000);
      }
    }
  }

  console.log("worker_stopped");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
