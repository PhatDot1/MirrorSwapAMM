import { ethers, artifacts, network } from "hardhat";
import fs from "fs";

type Addr = string;

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeDeployments(obj: any) {
  ensureDir("deployments");
  const path = `deployments/${network.name}.json`;
  fs.writeFileSync(path, JSON.stringify(obj, null, 2));
  console.log("deployments:", path);
}

function parseJsonArrayEnv(name: string): any[] | null {
  const v = process.env[name];
  if (!v) return null;
  try {
    const parsed = JSON.parse(v);
    if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array`);
    return parsed;
  } catch (e: any) {
    throw new Error(`Failed to parse ${name}. Expected JSON array. Got: ${v}\n${e.message}`);
  }
}

async function deployFromArtifact(name: string, args: any[]) {
  const artifact = await artifacts.readArtifact(name);
  const [deployer] = await ethers.getSigners();
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

function constructorInputsFromAbi(abi: any[]): { name: string; type: string }[] {
  const ctor = abi.find((x) => x.type === "constructor");
  return ctor?.inputs ?? [];
}

function printMirrorCtorHelp(inputs: { name: string; type: string }[], l1read: string, deployer: string) {
  console.log("\nMirrorState constructor inputs (ABI)");
  inputs.forEach((i, idx) => console.log(`  [${idx}] ${i.name || "(unnamed)"} : ${i.type}`));

  // template values
  const template = inputs.map((i) => {
    if (i.type === "address") return "$L1READ"; // user can replace some with deployer if needed
    if (i.type.startsWith("uint") || i.type.startsWith("int")) return 3600;
    if (i.type === "bool") return false;
    if (i.type === "bytes32") return "0x" + "00".repeat(32);
    if (i.type.startsWith("bytes")) return "0x";
    return null;
  });

  console.log("\nset env var:");
  console.log(
    `export MIRRORSTATE_CTOR_ARGS='${JSON.stringify(template)}'`
  );
  console.log(`replace placeholders:`);
  console.log(`- $L1READ -> ${l1read}`);
  console.log(`- $DEPLOYER -> ${deployer}`);
  console.log("");
}

async function main() {
  console.log("Network:", network.name);
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await deployer.provider!.getNetwork()).chainId);
  console.log("Deployer:", deployer.address);
  console.log("ChainId:", chainId);

  const isLocal = network.name === "localhost" || network.name === "hardhat";

  let l1read: Addr | undefined;
  let mirrorState: Addr | undefined;
  let base: Addr | undefined;
  let quote: Addr | undefined;
  let amm: Addr | undefined;

  if (isLocal) {
    // 1) MockL1Read
    const mockL1 = await deployFromArtifact("MockL1Read", []);
    l1read = await mockL1.getAddress();
    console.log("MockL1Read:", l1read);

    // pick set() overload
    const setFn =
      (mockL1 as any)["set(uint256,uint256)"] ??
      (mockL1 as any)["set(uint64,uint64)"] ??
      (mockL1 as any).set;

    if (!setFn) throw new Error("MockL1Read has no set() function in ABI?");
    await (await setFn(100000000000n, 0n)).wait(); // 1000 * 1e8
    // 2) MirrorState: args must match constructor
    const mirrorArtifact = await artifacts.readArtifact("MirrorState");
    const ctorInputs = constructorInputsFromAbi(mirrorArtifact.abi);

    let mirrorArgs = parseJsonArrayEnv("MIRRORSTATE_CTOR_ARGS");
    if (!mirrorArgs) {
      printMirrorCtorHelp(ctorInputs, l1read, deployer.address);
      throw new Error(
        `MirrorState constructor needs ${ctorInputs.length} args. ` +
          `Set MIRRORSTATE_CTOR_ARGS (JSON array) and rerun.`
      );
    }

    // Replace placeholders
    mirrorArgs = mirrorArgs.map((x) => {
      if (x === "$L1READ") return l1read;
      if (x === "$DEPLOYER") return deployer.address;
      return x;
    });

    let mirror: any;
    try {
      mirror = await deployFromArtifact("MirrorState", mirrorArgs);
    } catch (e: any) {
      console.log("\nMirrorState deploy failed with your args");
      console.log("MIRRORSTATE_CTOR_ARGS:", JSON.stringify(mirrorArgs));
      console.log("Constructor inputs (ABI):", ctorInputs);
      throw new Error(e.message);
    }

    mirrorState = await mirror.getAddress();
    console.log("MirrorState:", mirrorState);

    // 3) MockERC20 base/quote
    // Use env if needed; else try the common pattern (name,symbol,decimals)
    let baseArgs = parseJsonArrayEnv("MOCKERC20_CTOR_ARGS_BASE") ?? ["Mock Base", "BASE", 18];
    let quoteArgs = parseJsonArrayEnv("MOCKERC20_CTOR_ARGS_QUOTE") ?? ["Mock Quote", "QUOTE", 18];

    let baseToken: any;
    let quoteToken: any;
    try {
      baseToken = await deployFromArtifact("MockERC20", baseArgs);
    } catch (e: any) {
      throw new Error(
        `Failed deploying MockERC20 base with args=${JSON.stringify(baseArgs)}.\n` +
          `Set MOCKERC20_CTOR_ARGS_BASE='[...]' to match your MockERC20 constructor.\n` +
          `Original error:\n${e.message}`
      );
    }
    try {
      quoteToken = await deployFromArtifact("MockERC20", quoteArgs);
    } catch (e: any) {
      throw new Error(
        `Failed deploying MockERC20 quote with args=${JSON.stringify(quoteArgs)}.\n` +
          `Set MOCKERC20_CTOR_ARGS_QUOTE='[...]' to match your MockERC20 constructor.\n` +
          `Original error:\n${e.message}`
      );
    }

    base = await baseToken.getAddress();
    quote = await quoteToken.getAddress();
    console.log("Mock base:", base);
    console.log("Mock quote:", quote);

    // 4) Mint tokens to deployer (mint(address,uint256) OR mint(uint256))
    const mintAmt = 1_000_000n * 10n ** 18n;

    const mintAddrFn =
      (baseToken as any)["mint(address,uint256)"] ??
      (baseToken as any).mint;

    try {
      if ((baseToken as any)["mint(address,uint256)"]) {
        await (await (baseToken as any)["mint(address,uint256)"](deployer.address, mintAmt)).wait();
        await (await (quoteToken as any)["mint(address,uint256)"](deployer.address, mintAmt)).wait();
      } else {
        await (await (baseToken as any).mint(mintAmt)).wait();
        await (await (quoteToken as any).mint(mintAmt)).wait();
      }
      console.log("Minted tokens to deployer");
    } catch {
      console.log("Mint skipped (MockERC20 might not expose mint)");
    }

    // 5) MirrorAMM(base, quote, mirror)
    const ammC = await deployFromArtifact("MirrorAMM", [base, quote, mirrorState]);
    amm = await ammC.getAddress();
    console.log("MirrorAMM:", amm);

    // 6) YieldVaultMock(quote, admin)
    const vault = await deployFromArtifact("YieldVaultMock", [quote, deployer.address]);
    const vaultAddr = await vault.getAddress();
    console.log("YieldVaultMock:", vaultAddr);

    // 7) InstantonAllocator(amm, mirror, base, quote, vault, admin)
    const alloc = await deployFromArtifact("InstantonAllocator", [
      amm,
      mirrorState,
      base,
      quote,
      vaultAddr,
      deployer.address
    ]);
    const allocAddr = await alloc.getAddress();
    console.log("InstantonAllocator:", allocAddr);

    // Roles (call via signature to silence TS)
    const keeperRole =
      (alloc as any)["KEEPER_ROLE()"] ? await (alloc as any)["KEEPER_ROLE()"]() : await (alloc as any).KEEPER_ROLE();
    await (await (alloc as any)["grantRole(bytes32,address)"](keeperRole, deployer.address)).wait();
    const hasKeeper = await (alloc as any)["hasRole(bytes32,address)"](keeperRole, deployer.address);
    console.log("Granted KEEPER_ROLE to deployer:", hasKeeper);

    const managerRole =
      (vault as any)["MANAGER_ROLE()"] ? await (vault as any)["MANAGER_ROLE()"]() : await (vault as any).MANAGER_ROLE();
    await (await (vault as any)["grantRole(bytes32,address)"](managerRole, allocAddr)).wait();
    const hasManager = await (vault as any)["hasRole(bytes32,address)"](managerRole, allocAddr);
    console.log("Granted MANAGER_ROLE to allocator:", hasManager);

    // Save deployments
    writeDeployments({
      chainId,
      deployer: deployer.address,
      MockL1Read: l1read,
      MirrorState: mirrorState,
      BaseToken: base,
      QuoteToken: quote,
      MirrorAMM: amm,
      YieldVaultMock: vaultAddr,
      InstantonAllocator: allocAddr
    });

    console.log("deploy done");
    console.log("\nnext:");
    console.log("  npx hardhat run scripts/02-oracle-lifecycle.ts --network localhost");
    console.log("  npx hardhat run scripts/03-amm-swap.ts --network localhost");
    console.log("  npx hardhat run scripts/04-instanton-trigger.ts --network localhost");
    return;
  }

  throw new Error("This deploy script is intended for localhost/hardhat mode right now.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
