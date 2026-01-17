import { ethers, artifacts, network } from "hardhat";
import fs from "fs";

type Deployments = {
  chainId: number;
  deployer: string;
  MockL1Read: string;
  MirrorState: string;
  MirrorAMM: string;
  InstantonAllocator: string;
  BaseToken: string;
  QuoteToken: string;
};

function loadDeployments(): Deployments {
  const p = "deployments/localhost.json";
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}. Run deploy script first.`);
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  for (const k of Object.keys(raw)) {
    if (typeof raw[k] === "string" && raw[k].startsWith("0x") && raw[k].length === 42) {
      raw[k] = ethers.getAddress(raw[k].toLowerCase());
    }
  }
  return raw as Deployments;
}

const fmt18 = (x: bigint) => ethers.formatUnits(x, 18);

async function main() {
  const dep = loadDeployments();

  console.log("Network:", network.name);
  const [deployer] = await ethers.getSigners();
  const chainId = (await deployer.provider!.getNetwork()).chainId;
  console.log("Deployer:", deployer.address);
  console.log("ChainId:", chainId.toString());

  const mirrorAbi = (await artifacts.readArtifact("MirrorState")).abi;
  const ammAbi = (await artifacts.readArtifact("MirrorAMM")).abi;
  const allocArt = await artifacts.readArtifact("InstantonAllocator");
  const allocAbi = allocArt.abi;

  const mirror = new ethers.Contract(dep.MirrorState, mirrorAbi, deployer);
  const amm = new ethers.Contract(dep.MirrorAMM, ammAbi, deployer);
  const allocator = new ethers.Contract(dep.InstantonAllocator, allocAbi, deployer);

  // snapshot
  const tierInfo = await mirror.oracleTier();
  const tier: bigint = tierInfo[1];
  const emergencyStale: boolean = tierInfo[3];

  const pRef: bigint = await mirror.pRef();
  const theta = await mirror.theta();
  const qWad: bigint = await amm.qWad();

  console.log("\npre-trigger");
  console.log("oracle tier:", tier.toString(), "emergencyStale:", emergencyStale);
  console.log("pRef:", fmt18(pRef));
  console.log("theta.c:", fmt18(theta[0] as bigint));
  console.log("theta.lambda:", fmt18(theta[1] as bigint));
  console.log("theta.s:", fmt18(theta[2] as bigint));
  console.log("AMM qWad:", fmt18(qWad));

  // trigger
  console.log("\ncalling allocator.trigger()");
  const tx = await allocator.trigger();
  const rc = await tx.wait();
  console.log("trigger tx:", rc.hash);

  // allocator logs
  console.log("\nallocator logs");
  let printed = 0;

  for (const log of rc.logs) {
    try {
      const parsed = allocator.interface.parseLog(log);
      console.log(`event: ${parsed.name}`);
      // args
      const obj: any = {};
      for (const [k, v] of Object.entries(parsed.args)) {
        if (!isNaN(Number(k))) continue; // skip numeric indexes
        obj[k] = typeof v === "bigint" ? v.toString() : v;
      }
      console.log(obj);
      printed++;
    } catch {
      // not ours
    }
  }

  if (printed === 0) {
    console.log("(no allocator events decoded)");
  }

  // post
  const qAfter: bigint = await amm.qWad();
  console.log("\npost-trigger");
  console.log("AMM qWad:", fmt18(qAfter));
  console.log("\ndone");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
