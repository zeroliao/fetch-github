import { loadLocalEnv } from "@/server/loadEnv";
import { runNextScanJob } from "@/server/scanRunner";
import { getQueueStats, listProfiles, listScanJobs } from "@/server/store";

async function main() {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const profiles = await listProfiles();
  const jobs = await listScanJobs();

  console.log("fetchGithub worker bootstrap");
  console.log(`profiles=${profiles.length} jobs=${jobs.length}`);

  while (!stopping) {
    loadLocalEnv(process.cwd(), { overrideEmpty: true });

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
      continue;
    }

    const queueStats = await getQueueStats();
    console.log(`queue_stats=${JSON.stringify(queueStats)}`);
    await delay(3000);
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
