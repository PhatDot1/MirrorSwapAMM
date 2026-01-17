import { ethers, network } from "hardhat";
import fs from "fs";

type Deps = {
  chainId: number;
  MockL1Read: string;
  MirrorState: string;
};

function loadDeps(): Deps {
  const p = "deployments/localhost.json";
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}`);
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function fmt18(x: bigint) {
  return ethers.formatUnits(x, 18);
}

async function main() {
  const deps = loadDeps();
  console.log("Network:", network.name);

  const [deployer] = await ethers.getSigners();
  const chainId = (await deployer.provider!.getNetwork()).chainId;
  console.log("Deployer:", deployer.address);
  console.log("ChainId:", chainId.toString());

  const mock = await ethers.getContractAt("MockL1Read", deps.MockL1Read);
  const mirror = await ethers.getContractAt("MirrorState", deps.MirrorState);

  // current oracle state
  const t0 = await mirror.theta(); // tuple: [c, lambda, s]
  const pRef0 = await mirror.pRef();
  const last0 = await mirror.lastUpdate();

  console.log("\nMirrorState (before)");
  console.log("pRef (1e18):", fmt18(pRef0));
  console.log("theta.c:", fmt18(t0[0]));
  console.log("theta.lambda:", fmt18(t0[1]));
  console.log("theta.s:", fmt18(t0[2]));
  console.log("lastUpdate:", last0.toString());

  // mock live price uses 1e8
  const livePrice_1e8 = 2100n * 100_000_000n;
  const conf = 0n;

  const tx1 = await mock.set(livePrice_1e8, conf);
  await tx1.wait();

  console.log("\nMockL1Read price1e8:", livePrice_1e8.toString(), "conf:", conf.toString());

  // 1e8 -> 1e18
  const pRef_1e18 = livePrice_1e8 * 10_000_000_000n;

  // push update
  const c = ethers.parseUnits("7.649692623711514", 18);
  const lambda = ethers.parseUnits("0.01", 18);
  const s = ethers.parseUnits("0.001", 18);

  const block = await deployer.provider!.getBlock("latest");
  if (!block) throw new Error("No latest block?");
  const tsFresh = BigInt(block.timestamp);

  const update = {
    pRef: pRef_1e18,
    theta: { c, lambda, s },
    sigma: ethers.parseUnits("0.05", 18),
    imbalance: 0n,
    timestamp: tsFresh,
  };

  const tx2 = await mirror.pushUpdate(update);
  await tx2.wait();
  console.log("\nPushed update");

  const t1 = await mirror.theta();
  const pRef1 = await mirror.pRef();
  const last1 = await mirror.lastUpdate();

  console.log("\nMirrorState (after push)");
  console.log("pRef (1e18):", fmt18(pRef1));
  console.log("theta.c:", fmt18(t1[0]));
  console.log("theta.lambda:", fmt18(t1[1]));
  console.log("theta.s:", fmt18(t1[2]));
  console.log("lastUpdate:", last1.toString());

  // stale update should revert
  const tsOld = tsFresh - 3600n; // 1 hour old
  const staleUpdate = { ...update, timestamp: tsOld };

  console.log("\nTrying stale push (should revert)...");
  try {
    const tx3 = await mirror.pushUpdate(staleUpdate);
    await tx3.wait();
    console.log("stale push succeeded (should have reverted)");
  } catch (e: any) {
    console.log("stale push reverted");
    console.log("reason:", (e?.shortMessage || e?.message || "").split("\n")[0]);
  }

  console.log("\ndone");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
