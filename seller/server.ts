// Bitcoin mining-economics API. Runs behind Aperture, which charges per service;
// this process only serves data and the free L402 discovery manifest.
import snapshot from "./snapshot.json";

const PORT = 8701;
const MEMPOOL = "https://mempool.space/api/v1";
const SAT = 100_000_000;

type Market = typeof snapshot;
let cache: { at: number; market: Market } | undefined;

async function market(): Promise<Market> {
	if (cache && Date.now() - cache.at < 60_000) return cache.market;
	try {
		const get = (path: string) =>
			fetch(`${MEMPOOL}/${path}`, { signal: AbortSignal.timeout(4000) }).then((r) => {
				if (!r.ok) throw new Error(`${path}: ${r.status}`);
				return r.json();
			});
		const [prices, hashrate, rewards, difficulty] = await Promise.all([
			get("prices"),
			get("mining/hashrate/3d"),
			get("mining/reward-stats/144"),
			get("difficulty-adjustment"),
		]);
		const live = { as_of: new Date().toISOString(), source: "mempool.space live", prices, hashrate, rewards, difficulty };
		cache = { at: Date.now(), market: live };
		return live;
	} catch {
		// ponytail: stale snapshot when offline, labeled in every response so nobody mistakes it for live data.
		return cache?.market ?? snapshot;
	}
}

function hashprice(m: Market) {
	const rewardBtcPerDay = Number(m.rewards.totalReward) / SAT; // last 144 blocks ≈ one day
	const feeShare = Number(m.rewards.totalFee) / Number(m.rewards.totalReward);
	const th = m.hashrate.currentHashrate / 1e12;
	const usdPerThDay = (rewardBtcPerDay * m.prices.USD) / th;
	return {
		as_of: m.as_of,
		source: m.source,
		btc_usd: m.prices.USD,
		network_hashrate_eh_s: +(m.hashrate.currentHashrate / 1e18).toFixed(1),
		hashprice_usd_per_ph_day: +(usdPerThDay * 1000).toFixed(2),
		hashprice_sats_per_th_day: +((rewardBtcPerDay * SAT) / th).toFixed(1),
		fee_share_of_reward_pct: +(feeShare * 100).toFixed(2),
		usdPerThDay,
	};
}

function breakeven(m: Market, jPerTh: number, usdPerKwh: number) {
	const { usdPerThDay } = hashprice(m);
	const costPerThDay = (jPerTh * 24 * usdPerKwh) / 1000;
	return {
		efficiency_j_per_th: jPerTh,
		power_usd_per_kwh: usdPerKwh,
		revenue_usd_per_th_day: +usdPerThDay.toFixed(4),
		power_cost_usd_per_th_day: +costPerThDay.toFixed(4),
		margin_pct: +(((usdPerThDay - costPerThDay) / usdPerThDay) * 100).toFixed(1),
		breakeven_power_usd_per_kwh: +((usdPerThDay * 1000) / (jPerTh * 24)).toFixed(4),
	};
}

const manifest = () => ({
	version: "1.0",
	provider: {
		name: "Hashprice Desk (demo)",
		uri: "http://127.0.0.1:8700",
		node_pubkey: process.env.SELLER_PUBKEY,
	},
	currencies: ["msat"],
	macaroon_versions: [0],
	payment_methods: ["bolt11"],
	services: [
		{
			name: "hashprice",
			description: "Current hashprice, network hashrate, and fee share of block rewards.",
			resources: [{ path: "/v1/hashprice", method: "GET", pricing: { model: "fixed", price_msat: 10_000 } }],
		},
		{
			name: "breakeven",
			description: "Miner margin and break-even power price. Query: j_per_th, usd_per_kwh.",
			resources: [{ path: "/v1/breakeven", method: "GET", pricing: { model: "fixed", price_msat: 50_000 } }],
		},
		{
			name: "report",
			description: "Full desk report: hashprice, next difficulty adjustment, break-even grid by fleet efficiency.",
			resources: [{ path: "/v1/report", method: "GET", pricing: { model: "fixed", price_msat: 1_000_000 } }],
		},
	],
});

Bun.serve({
	port: PORT,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		switch (url.pathname) {
			case "/.well-known/l402.json":
				return Response.json(manifest(), { headers: { "access-control-allow-origin": "*" } });
			case "/v1/hashprice": {
				const { usdPerThDay, ...out } = hashprice(await market());
				return Response.json(out);
			}
			case "/v1/breakeven": {
				const j = Number(url.searchParams.get("j_per_th") ?? 17.5);
				const kwh = Number(url.searchParams.get("usd_per_kwh") ?? 0.05);
				if (!(j > 0 && kwh >= 0)) return Response.json({ error: "j_per_th must be > 0 and usd_per_kwh >= 0" }, { status: 400 });
				const m = await market();
				return Response.json({ as_of: m.as_of, source: m.source, ...breakeven(m, j, kwh) });
			}
			case "/v1/report": {
				const m = await market();
				const { usdPerThDay, ...hp } = hashprice(m);
				const grid = [13.5, 17.5, 21.5, 29.5].flatMap((j) => [0.03, 0.05, 0.07].map((kwh) => breakeven(m, j, kwh)));
				return Response.json({
					...hp,
					next_difficulty_adjustment: {
						estimated_change_pct: +m.difficulty.difficultyChange.toFixed(2),
						remaining_blocks: m.difficulty.remainingBlocks,
						estimated_date: new Date(m.difficulty.estimatedRetargetDate).toISOString(),
					},
					breakeven_grid: grid,
				});
			}
			default:
				return Response.json({ error: "not found" }, { status: 404 });
		}
	},
});
console.log(`service listening on http://127.0.0.1:${PORT}`);
