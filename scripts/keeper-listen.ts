import { ethers, artifacts, network } from "hardhat";
import fs from "fs";

function loadDeployments() {
  const p = `deployments/${network.name}.json`;
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}. Run deploy first.`);
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  for (const k of Object.keys(raw)) {
    if (typeof raw[k] === "string" && raw[k].startsWith("0x") && raw[k].length === 42) {
      raw[k] = ethers.getAddress(raw[k].toLowerCase());
    }
  }
  return raw;
}

const fmt18 = (x: bigint) => ethers.formatUnits(x, 18);

async function main() {
  console.log("Network:", network.name);
  const dep = loadDeployments();
  const [signer] = await ethers.getSigners();

  const allocArt = await artifacts.readArtifact("InstantonAllocator");
  const allocator = new ethers.Contract(dep.InstantonAllocator, allocArt.abi, signer);

  console.log("Listening on allocator:", dep.InstantonAllocator);

  allocator.on("InstantonDecision", (venue: number, SWad: bigint, qWad: bigint, tier: number, emergencyStale: boolean, pRefWad: bigint, sEffWad: bigint) => {
    console.log("\n[InstantonDecision]");
    console.log({
      venue,
      S: fmt18(SWad),
      q: fmt18(qWad),
      tier,
      emergencyStale,
      pRef: fmt18(pRefWad),
      sEff: fmt18(sEffWad),
    });
  });

  allocator.on("QuoteIntent", (isBuyBase: boolean, baseAmountWad: bigint, limitPriceWad: bigint) => {
    console.log("\n[QuoteIntent]");
    console.log({
      side: isBuyBase ? "BUY_BASE" : "SELL_BASE",
      baseAmount: fmt18(baseAmountWad),
      limitPrice: fmt18(limitPriceWad),
    });
    console.log("Keeper: would place HyperCore order here (API wallet).");
  });

  allocator.on("RebalanceIntent", (venue: number, quoteAmountWad: bigint) => {
    console.log("\n[RebalanceIntent]");
    console.log({
      venue,
      quoteAmount: fmt18(quoteAmountWad),
    });
  });

  console.log("Keeper running... (Ctrl+C to stop)");
  // keep alive
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
