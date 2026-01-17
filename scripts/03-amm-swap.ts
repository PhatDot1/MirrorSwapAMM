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

async function safeCall<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    console.error(`\nreverted during: ${label}`);
    console.error(e?.shortMessage ?? e?.message ?? e);
    throw e;
  }
}

async function main() {
  const dep = loadDeployments();

  console.log("Network:", network.name);
  const [deployer] = await ethers.getSigners();
  const chainId = (await deployer.provider!.getNetwork()).chainId;
  console.log("Deployer:", deployer.address);
  console.log("ChainId:", chainId.toString());

  const mirrorAbi = (await artifacts.readArtifact("MirrorState")).abi;
  const ammAbi = (await artifacts.readArtifact("MirrorAMM")).abi;
  const erc20Abi = (await artifacts.readArtifact("MockERC20")).abi;
  const l1readAbi = (await artifacts.readArtifact("MockL1Read")).abi;

  const mirror = new ethers.Contract(dep.MirrorState, mirrorAbi, deployer);
  const amm = new ethers.Contract(dep.MirrorAMM, ammAbi, deployer);
  const l1read = new ethers.Contract(dep.MockL1Read, l1readAbi, deployer);

  // token addresses from AMM (truth source)
  const baseAddr = ethers.getAddress((await amm.base()).toLowerCase());
  const quoteAddr = ethers.getAddress((await amm.quote()).toLowerCase());
  const base = new ethers.Contract(baseAddr, erc20Abi, deployer);
  const quote = new ethers.Contract(quoteAddr, erc20Abi, deployer);

  // oracle refresh
  const price1e8 = 2100n * 10n ** 8n;
  const conf1e8 = 0n;

  console.log("\nOracle refresh");
  await (await l1read.set(price1e8, conf1e8)).wait();
  console.log("MockL1Read set price (1e8):", price1e8.toString());

  const block = await deployer.provider!.getBlock("latest");
  const now = BigInt(block!.timestamp);

  const cWad = ethers.parseUnits(Math.log(2100).toString(), 18);
  const lambdaWad = ethers.parseUnits("0.01", 18);
  const sWad = ethers.parseUnits("0.001", 18);
  const sigmaWad = ethers.parseUnits("0.02", 18);

  const update = {
    timestamp: now,
    pRef: ethers.parseUnits("2100", 18),
    theta: { c: cWad, lambda: lambdaWad, s: sWad },
    sigma: sigmaWad,
    imbalance: 0n,
  };

  await (await mirror.pushUpdate(update)).wait();
  console.log("Pushed fresh oracle update at timestamp:", now.toString());

  const tierInfo = await mirror.oracleTier();
  const tier = tierInfo[1];
  const emergencyStale = tierInfo[3];
  console.log("oracle tier:", tier.toString(), "emergencyStale:", emergencyStale);
  if (emergencyStale) throw new Error("Oracle still stale after refresh.");

  // snapshots
  const pRef: bigint = await mirror.pRef();
  const theta = await mirror.theta();
  console.log("\nMirrorState");
  console.log("pRef (1e18):", fmt18(pRef));
  console.log("theta.c:", fmt18(theta[0] as bigint));
  console.log("theta.lambda:", fmt18(theta[1] as bigint));
  console.log("theta.s:", fmt18(theta[2] as bigint));

  const q0: bigint = await amm.qWad();
  console.log("\nAMM params");
  console.log("qWad:", fmt18(q0));
  console.log("etaWad:", fmt18((await amm.etaWad()) as bigint));
  console.log("qMaxWad:", fmt18((await amm.qMaxWad()) as bigint));
  console.log("maxTradeBaseWad:", fmt18((await amm.maxTradeBaseWad()) as bigint));
  console.log("base token:", baseAddr);
  console.log("quote token:", quoteAddr);

  // make sure deployer has balances (fresh redeploy-safe)
  const seedBase = ethers.parseUnits("10", 18);
  const seedQuote = ethers.parseUnits("25000", 18);

  const sellBaseIn = ethers.parseUnits("0.01", 18);
  const buyBaseOut = ethers.parseUnits("0.005", 18);

  // extra quote buffer for BUY
  const extraQuoteBuffer = ethers.parseUnits("10000", 18);

  const wantBase = seedBase + sellBaseIn; // enough to seed and sell
  const wantQuote = seedQuote + extraQuoteBuffer; // enough to seed and buy

  let traderBase: bigint = await base.balanceOf(deployer.address);
  let traderQuote: bigint = await quote.balanceOf(deployer.address);

  console.log("\nTrader balances (before)");
  console.log("base:", fmt18(traderBase));
  console.log("quote:", fmt18(traderQuote));

  if (traderBase < wantBase) {
    const missing = wantBase - traderBase;
    console.log(`\nMinting BASE (missing ${fmt18(missing)})...`);
    await (await base.mint(deployer.address, missing)).wait();
  }

  traderBase = await base.balanceOf(deployer.address);
  if (traderQuote < wantQuote) {
    const missing = wantQuote - traderQuote;
    console.log(`\nMinting QUOTE (missing ${fmt18(missing)})...`);
    await (await quote.mint(deployer.address, missing)).wait();
  }

  traderBase = await base.balanceOf(deployer.address);
  traderQuote = await quote.balanceOf(deployer.address);

  console.log("\nTrader balances (after mint)");
  console.log("base:", fmt18(traderBase));
  console.log("quote:", fmt18(traderQuote));

  // seed AMM if needed
  const ammBaseBal: bigint = await base.balanceOf(dep.MirrorAMM);
  const ammQuoteBal: bigint = await quote.balanceOf(dep.MirrorAMM);

  console.log("\nAMM balances (before seed)");
  console.log("AMM base:", fmt18(ammBaseBal));
  console.log("AMM quote:", fmt18(ammQuoteBal));

  if (ammBaseBal < seedBase) {
    console.log("\nSeeding AMM with BASE...");
    await (await base.transfer(dep.MirrorAMM, seedBase - ammBaseBal)).wait();
  }
  if (ammQuoteBal < seedQuote) {
    console.log("\nSeeding AMM with QUOTE...");
    await (await quote.transfer(dep.MirrorAMM, seedQuote - ammQuoteBal)).wait();
  }

  console.log("\nAMM balances (after seed)");
  console.log("AMM base:", fmt18(await base.balanceOf(dep.MirrorAMM)));
  console.log("AMM quote:", fmt18(await quote.balanceOf(dep.MirrorAMM)));

  // approvals
  await (await base.approve(dep.MirrorAMM, ethers.MaxUint256)).wait();
  await (await quote.approve(dep.MirrorAMM, ethers.MaxUint256)).wait();

  // quote + swap SELL
  const sellQuoteOutWad: bigint = await safeCall("quoteForBaseDelta(SELL)", async () => {
    return (await amm.quoteForBaseDelta(false, BigInt(sellBaseIn))) as bigint;
  });

  console.log("\nQuote (SELL)");
  console.log("Sell base in:", fmt18(sellBaseIn));
  console.log("Expected quote out (wad):", fmt18(sellQuoteOutWad));

  console.log("\nExecuting SELL");
  await (await amm.swapSellBaseExactIn(sellBaseIn)).wait();
  console.log("SELL mined");

  // quote + swap BUY
  const buyQuoteInWad: bigint = await safeCall("quoteForBaseDelta(BUY)", async () => {
    return (await amm.quoteForBaseDelta(true, BigInt(buyBaseOut))) as bigint;
  });

  console.log("\nQuote (BUY)");
  console.log("Buy base out:", fmt18(buyBaseOut));
  console.log("Expected quote in (wad):", fmt18(buyQuoteInWad));

  console.log("\nExecuting BUY");
  await (await amm.swapBuyBaseExactOut(buyBaseOut)).wait();
  console.log("BUY mined");

  const qEnd: bigint = await amm.qWad();
  console.log("\nFinal qWad:", fmt18(qEnd));
  console.log("\ndone");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
