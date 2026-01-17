import hre, { ethers } from "hardhat";

/**
 * Natural log for a JS number, scaled to 1e18 (WAD).
 * Good enough for MVP / demo parameters.
 */
function lnWad(x: number): bigint {
  if (!(x > 0)) throw new Error("lnWad expects x > 0");
  const scaled = Math.floor(Math.log(x) * 1e18);
  return BigInt(scaled);
}

async function main() {
  const signers = await ethers.getSigners();
  if (!signers || signers.length === 0) {
    throw new Error(
      "No signers available. If deploying to hyperevm, set DEPLOYER_PK in .env. " +
        "If deploying to a local node, run with --network localhost."
    );
  }
  const deployer = signers[0];

  const net = await ethers.provider.getNetwork();
  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log("ChainId:", net.chainId.toString());

  const isLocal = hre.network.name === "localhost" || hre.network.name === "hardhat";

  // ---------- 1) L1Read ----------
  let l1readAddr: string;
  const assetIndex = Number(process.env.ASSET_INDEX ?? "0");

  if (isLocal) {
    const MockL1Read = await ethers.getContractFactory("MockL1Read");
    const mock = await MockL1Read.deploy();
    await mock.waitForDeployment();
    l1readAddr = await mock.getAddress();

    // price=100.00 in 1e8 (100 * 1e8), tier=0
    await (await mock.set(10_000_000_000, 0)).wait();
    console.log("MockL1Read:", l1readAddr);
  } else {
    const fromEnv = process.env.L1READ_ADDR;
    if (!fromEnv) throw new Error("Missing L1READ_ADDR in env for non-local deploy");
    l1readAddr = fromEnv;
  }

  // ---------- 2) Deploy MirrorState ----------
  const MirrorState = await ethers.getContractFactory("MirrorState");
  const mirrorState = await MirrorState.deploy(deployer.address, l1readAddr, assetIndex);
  await mirrorState.waitForDeployment();
  const mirrorAddr = await mirrorState.getAddress();
  console.log("MirrorState:", mirrorAddr);

  // ---------- 3) Deploy tokens ----------
  let baseAddr: string;
  let quoteAddr: string;

  if (isLocal) {
    const MockERC20 = await ethers.getContractFactory("MockERC20");

    const baseDep = await MockERC20.deploy("Mock Base", "mBASE", 18);
    await baseDep.waitForDeployment();
    baseAddr = await baseDep.getAddress();

    const quoteDep = await MockERC20.deploy("Mock Quote", "mQUOTE", 6);
    await quoteDep.waitForDeployment();
    quoteAddr = await quoteDep.getAddress();

    console.log("Mock base:", baseAddr);
    console.log("Mock quote:", quoteAddr);

    const base = await ethers.getContractAt("MockERC20", baseAddr);
    const quote = await ethers.getContractAt("MockERC20", quoteAddr);

    await (await base.mint(deployer.address, ethers.parseUnits("1000000", 18))).wait();
    await (await quote.mint(deployer.address, ethers.parseUnits("1000000", 6))).wait();
    console.log("Minted tokens to deployer");
  } else {
    const b = process.env.BASE_TOKEN;
    const q = process.env.QUOTE_TOKEN;
    if (!b || !q) throw new Error("Missing BASE_TOKEN or QUOTE_TOKEN in env");
    baseAddr = b;
    quoteAddr = q;
  }

  // ---------- 4) Deploy MirrorAMM ----------
  const MirrorAMM = await ethers.getContractFactory("MirrorAMM");
  const amm = await MirrorAMM.deploy(baseAddr, quoteAddr, mirrorAddr);
  await amm.waitForDeployment();
  const ammAddr = await amm.getAddress();
  console.log("MirrorAMM:", ammAddr);

  // ---------- 5) Deploy InstantonAllocator ----------
  const InstantonAllocator = await ethers.getContractFactory("InstantonAllocator");
  const allocator = await InstantonAllocator.deploy(deployer.address, mirrorAddr, ammAddr);
  await allocator.waitForDeployment();
  const allocAddr = await allocator.getAddress();
  console.log("InstantonAllocator:", allocAddr);

  // ---------- 6) Grant roles ----------
  // Prefer reading the role constant from the contract if it exists; otherwise fallback.
  let keeperRole: string;
  try {
    // many AccessControl contracts expose KEEPER_ROLE() as a public constant
    keeperRole = await (mirrorState as any).KEEPER_ROLE();
  } catch {
    keeperRole = ethers.keccak256(ethers.toUtf8Bytes("KEEPER_ROLE"));
  }

  await (await mirrorState.grantRole(keeperRole, deployer.address)).wait();
  await (await allocator.grantRole(keeperRole, deployer.address)).wait();

  const hasKeeper = await mirrorState.hasRole(keeperRole, deployer.address);
  console.log("Granted KEEPER_ROLE to deployer:", hasKeeper);

  // ---------- 7) Push initial oracle update + approvals + trigger ----------
  if (isLocal) {
    // pRef is WAD (1e18). We'll set pRef = 100
    const pRef = 100n * 10n ** 18n;

    // IMPORTANT: c should be ln(pRef_unscaled), per your paper.
    // If pRef = 100, then c = ln(100).
    const c = lnWad(100);

    // lambda=0.01, s=0.001
    const theta = {
      c,                  // ln(100) * 1e18
      lambda: 10n ** 16n, // 0.01e18
      s: 10n ** 15n,      // 0.001e18
    };

    const latestBlock = await ethers.provider.getBlock("latest");
if (!latestBlock) throw new Error("Could not fetch latest block");
const now = BigInt(latestBlock.timestamp);


    const update = {
      pRef,
      theta,
      sigma: 2n * 10n ** 16n, // 0.02e18
      imbalance: 0n,
      timestamp: now,
    };

    // Preflight to surface revert reasons when possible
    try {
      await (mirrorState as any).pushUpdate.staticCall(update);
    } catch (e) {
      console.error("pushUpdate.staticCall failed (this is the real revert reason if shown):");
      console.error(e);
      throw e;
    }

    await (await (mirrorState as any).pushUpdate(update)).wait();
    console.log("Pushed initial oracle update");

    const base = await ethers.getContractAt("MockERC20", baseAddr);
    const quote = await ethers.getContractAt("MockERC20", quoteAddr);

    await (await base.approve(ammAddr, ethers.MaxUint256)).wait();
    await (await quote.approve(ammAddr, ethers.MaxUint256)).wait();
    console.log("Approved AMM to spend deployer tokens");

    const tx = await allocator.trigger();
    const rcpt = await tx.wait();
    console.log("Allocator trigger mined. logs:", rcpt?.logs.length ?? 0);
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
