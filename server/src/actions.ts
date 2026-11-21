// ViceSunshine actions: source-backed news/patches with a daily web-search
// refresh, plus fully user-owned community data (bugs,
// eggs, guides, profiles, clans with the 5-role hierarchy, LFG,
// events, faction war). Note: the official GTA VI map has not been
// released — there are no verified map pins until after launch on
// Nov 19, 2026, so pin creation is disabled and listPins returns none.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, desc, eq, like, or } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "./schema";
import { sendCodeEmail } from "../standalone/email";

const okResponse = z.object({ ok: z.literal(true) });
type Ok = z.infer<typeof okResponse>;
const ok = (): Ok => ({ ok: true });

// Global search (search overlay + full results view): one hit shape
// for every group — refId is the row's numeric id, extra carries the
// Database kind, and refKey is always empty: a playerKey is an
// account credential and is never exposed as a search identifier.
const searchHit = z.object({
  refId: z.number(),
  refKey: z.string(),
  title: z.string(),
  subtitle: z.string(),
  extra: z.string(),
});
const recordSearchResponse = z.object({ ok: z.literal(true), count: z.number() });

const platformEnum = z.enum(["PS5", "Xbox", "Both"]);
const linksShape = z.object({
  psn: z.string(),
  xbox: z.string(),
  discord: z.string(),
  // The player's Rockstar Social Club ID, already visibility-filtered
  // by visibleLinks: empty unless it is public, or the viewer is the
  // player themselves or a crew mate (a private ID is crew-only).
  rockstar: z.string(),
  others: z.array(z.object({ label: z.string(), url: z.string() })),
});
const ROLE_RANK: Record<string, number> = {
  Leader: 5,
  "Co-Leader": 4,
  Elder: 3,
  Member: 2,
  Recruit: 1,
};

// Game layer for clans, derived only from real clan record fields:
// trophies and XP are computed from faction points, wins, events held
// and member count — nothing is stored or invented separately.
function clanGame(r: { factionPoints: number; wins: number; eventsHeld: number }, memberCount: number) {
  const trophies = r.factionPoints + r.wins * 100 + r.eventsHeld * 25;
  const xp = r.factionPoints + r.wins * 50 + r.eventsHeld * 20 + memberCount * 10;
  const level = Math.min(15, 1 + Math.floor(xp / 200));
  const league =
    trophies >= 2000 ? "Vice Legend" :
    trophies >= 1000 ? "Leonida Elite" :
    trophies >= 600 ? "Downtown Vice" :
    trophies >= 300 ? "Neon Strip" :
    trophies >= 100 ? "Vice Beach" : "Ocean Drive";
  return { trophies, xp, level, league };
}
type ClanRankStats = {
  rankPoints: number;
  seasonPoints: number;
  effectiveSeasonPoints: number;
  effectiveLifetimePoints: number;
  multiplier: number;
  avgMemberLevel: number;
  rankLevel: number;
  rankNextLevelPoints: number;
  rankPointsToNext: number;
};
const EMPTY_RANK: ClanRankStats = {
  rankPoints: 0, seasonPoints: 0, effectiveSeasonPoints: 0,
  effectiveLifetimePoints: 0, multiplier: 1, avgMemberLevel: 1,
  rankLevel: 1, rankNextLevelPoints: 200, rankPointsToNext: 200,
};
function clanSummaryOf(
  r: typeof schema.clans.$inferSelect,
  memberCount: number,
  rank: ClanRankStats = EMPTY_RANK,
  extra: { warsWon?: number; seasonRank?: number } = {},
) {
  const g = clanGame(r, memberCount);
  return {
    id: r.id, name: r.name, tag: r.tag, color: r.color, motto: r.motto,
    description: r.description, rules: r.rules ?? "", platform: r.platform, region: r.region,
    language: r.language, playstyle: r.playstyle, privacy: r.privacy,
    maxMembers: r.maxMembers, memberCount, eventsHeld: r.eventsHeld,
    wins: r.wins, faction: r.faction, factionPoints: r.factionPoints,
    // Effects were removed from ViceSunshine (Nov 19, 2026): no emblem
    // or profile effects exist anymore, so this is always empty and
    // nothing renders one, whatever an old row still stores.
    emblem: r.emblem || "shield", emblemEffect: "", ...g,
    walletCredits: r.walletCredits ?? 0,
    // Clan banner styles are gone — the clan calling card is the banner.
    bannerStyle: "",
    callingCard: r.callingCard ?? "",
    nameColor: "",
    warsWon: extra.warsWon ?? 0,
    seasonRank: extra.seasonRank ?? 0,
    ...rank,
  };
}

// This season's global rank per clan (1-based, by effective season
// points) — used for the Tracker-style stat tiles on clan cards and
// clan homes. (Clan Wars were removed at the owner's direction —
// Community Events hosted by clan Leaders replaced them.)
function seasonRankMap(stats: Map<number, ClanRankStats>): Map<number, number> {
  const sorted = [...stats.entries()].sort(
    (a, b) => b[1].effectiveSeasonPoints - a[1].effectiveSeasonPoints || b[1].effectiveLifetimePoints - a[1].effectiveLifetimePoints,
  );
  const map = new Map<number, number>();
  sorted.forEach(([clanId], i) => map.set(clanId, i + 1));
  return map;
}

// ---- Vice Credits / Rank Points / seasons ----
// Honest model: ViceSunshine cannot see inside GTA VI (single-player at
// launch, no Rockstar API, no PlayStation / Xbox game data), so Rank
// Points are counted ONLY from actions that happen inside ViceSunshine
// itself — RSVPs, posts, LFG teams, joins, tracker confirmations by
// moderators, host-confirmed event results, real in-app likes. Those
// are verifiable because the app recorded them. Self-reported mission
// ticks are personal progress only (small personal points, trust-based).
const STARTING_CREDITS = 500;
const CLAN_CREATE_COST = 500;
// Refer a Friend (owner's rule, Nov 19 2026): when a friend joins
// with your referral code, YOU earn Vice Credits — no more Premium
// discount. 200 credits is exactly the price of one extra community
// event beyond the weekly limit, and the recruit also earns you
// +15 XP (Rank Points) — the same recruit rate as POINT_RATES —
// counted automatically from the sign-up, like every other reward.
const REFERRAL_CREDITS = 200;
// Starting one extra community event beyond the Leader's one free
// event per week costs 200 Vice Credits (owner's credits rule:
// credits are only ever for crew creation and extra events).
const EXTRA_EVENT_COST = 200;
const POINT_RATES = {
  eventAttend: 15,
  eventWin: [50, 30, 20] as const, // 1st / 2nd / 3rd
  egg: 25,
  bug: 20,
  recruit: 15,
  feed: 10, // a Feed post reaching 10 real likes
  feedPost: 5, // publishing a Feed post
  clanPost: 2,
};
const SEASON_TOP10_CREDITS = 100;

function seasonKeyOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}
function seasonLabelOf(key: string): string {
  const [y = 1970, m = 1] = key.split("-").map(Number);
  const name = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return name;
}
function seasonEndsAtOf(key: string): string {
  const [y = 1970, m = 1] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function previousSeasonKeyOf(key: string): string {
  const [y = 1970, m = 1] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

// Player ViceSunshine level (NOT an official Rockstar / GTA VI level —
// ViceSunshine cannot see inside the game). The level is driven by XP,
// and XP is exactly the player's Rank Points: both are earned ONLY from
// activity inside ViceSunshine itself, counted automatically (see
// POINT_RATES). Level thresholds (owner's table, Nov 19 2026): Level 2
// at 200 XP, Level 3 at 500, Level 4 at 1,000, Level 5 at 2,000, then
// widening steps — the same ladder the clan rank level uses.
const XP_LEVEL_STEPS = [0, 200, 500, 1000, 2000, 3500, 5500, 8000, 11000, 14500];
function xpThresholdForLevel(level: number): number {
  if (level <= 1) return 0;
  if (level <= XP_LEVEL_STEPS.length) return XP_LEVEL_STEPS[level - 1] ?? 0;
  // Beyond the table each level costs more than the last (+4,000, then
  // +4,500, +5,000, …) so high levels stay a real grind.
  let total = XP_LEVEL_STEPS[XP_LEVEL_STEPS.length - 1] ?? 14500;
  let step = 4000;
  for (let l = XP_LEVEL_STEPS.length + 1; l <= level; l++) {
    total += step;
    step += 500;
  }
  return total;
}
function playerLevelFromPoints(points: number): { level: number; nextAt: number; levelStart: number } {
  const p = Math.max(0, points);
  let level = 1;
  while (xpThresholdForLevel(level + 1) <= p) level += 1;
  return { level, nextAt: xpThresholdForLevel(level + 1), levelStart: xpThresholdForLevel(level) };
}
function playerTierOf(level: number): number {
  return 1 + Math.floor((level - 1) / 5);
}
// Clan Level is lifetime, from total confirmed Rank Points (effective,
// after the member-level multiplier). Level 1 at 0, 2 at 200, 3 at 500,
// 4 at 1000, 5 at 2000, then widening steps.
const CLAN_LEVEL_STEPS = [0, 200, 500, 1000, 2000, 3500, 5500, 8000, 11000, 14500];
function clanRankLevelFromPoints(points: number): { level: number; nextAt: number } {
  let level = 1;
  for (let i = 0; i < CLAN_LEVEL_STEPS.length; i++) {
    if (points >= (CLAN_LEVEL_STEPS[i] ?? 0)) level = i + 1;
  }
  let nextAt = CLAN_LEVEL_STEPS[level] ?? 0;
  if (!nextAt) {
    // Beyond the table: each further level costs 3500 more than the last step.
    const last = CLAN_LEVEL_STEPS[CLAN_LEVEL_STEPS.length - 1] ?? 14500;
    nextAt = last + (level - CLAN_LEVEL_STEPS.length + 1) * 3500;
  }
  return { level, nextAt };
}

type CosmeticItemDef = {
  id: string;
  name: string;
  description: string;
  scope: "clan" | "personal";
  kind: "emblem" | "color" | "banner" | "badge" | "bannerColor" | "avatar" | "effect" | "callingCard" | "theme";
  value: string;
  // Premium-only items are part of the Premium membership — never
  // sold separately and never equippable without an active Premium.
  // Every catalogue section holds exactly 3 Premium items (and
  // exactly 5 free items) — see the catalogue rule below.
  premiumOnly?: boolean;
};
// ---- Customise catalogue — exactly 5 free + 3 Premium per section ----
// Owner's rule (Nov 19, 2026): EVERY Customise section holds exactly
// 5 free items and 3 Premium items — 8 items per section, no more.
// A "section" is one scope + kind group below (Avatars,
// Avatar Effects, Profile Banners, Badges,
// Calling Cards, Themes, Clan Emblems, Clan Colours, Clan Banners,
// Clan Calling Cards). There are NO name colours: every name in
// ViceSunshine is shown in white only.. Everything that used to
// overflow those sections — the extra themed sets and the whole
// monthly Premium drop system — has been removed. Premium items are
// part of the Premium membership, never sold separately, and never
// equippable without an active Premium. Clan Awards (below) are a
// separate earned system and are NOT part of this catalogue.
const COSMETIC_ITEMS: CosmeticItemDef[] = [
  // -- Avatars (personal) — 5 free + 3 Premium --
  { id: "avatar-street", name: "Street avatar", description: "An original ViceSunshine street-style character avatar, animated on your profile, in the Feed and in crew listings. Free for every player.", scope: "personal", kind: "avatar", value: "street" },
  { id: "avatar-crew", name: "Crew avatar", description: "An original ViceSunshine crew-style character avatar, animated everywhere your avatar appears. Free for every player.", scope: "personal", kind: "avatar", value: "crew" },
  { id: "avatar-driver", name: "Driver avatar", description: "An original ViceSunshine driver character avatar — sunglasses, open road energy. Free for every player.", scope: "personal", kind: "avatar", value: "driver" },
  { id: "avatar-surfer", name: "Surfer avatar", description: "An original ViceSunshine surfer character avatar — Leonida Keys energy. Free for every player.", scope: "personal", kind: "avatar", value: "surfer" },
  { id: "avatar-racer", name: "Racer avatar", description: "An original ViceSunshine street-racer character avatar. Free for every player.", scope: "personal", kind: "avatar", value: "racer" },
  { id: "avatar-neon-outlaw", name: "Neon Outlaw avatar — Premium", description: "Premium exclusive — an original ViceSunshine neon outlaw with a glowing pink visor. Free members cannot use this avatar.", scope: "personal", kind: "avatar", value: "neon-outlaw", premiumOnly: true },
  { id: "avatar-alien-visitor", name: "Alien Visitor avatar — Premium", description: "Premium exclusive — an original ViceSunshine alien visitor in a silver Vice City jacket. Free members cannot use this avatar.", scope: "personal", kind: "avatar", value: "alien-visitor", premiumOnly: true },
  { id: "avatar-supercar-ace", name: "Supercar Ace avatar — Premium", description: "Premium exclusive — an original ViceSunshine supercar ace in a sleek racing suit. Free members cannot use this avatar.", scope: "personal", kind: "avatar", value: "supercar-ace", premiumOnly: true },
  // -- Avatar Effects (personal) — 5 free + 3 Premium --
  { id: "effect-ember-glow", name: "Vice Crown effect", description: "A gold crown fixed right onto the top of your avatar circle — crown, rim and avatar are one single piece, nothing floating. Free for every player.", scope: "personal", kind: "effect", value: "gold-aura" },
  { id: "effect-frost-ring", name: "Frost Horns effect", description: "Pale ice horns growing straight out of the top of your avatar circle, with a matching frost rim — one piece with the avatar. Free for every player.", scope: "personal", kind: "effect", value: "ice" },
  { id: "effect-shadow-veil", name: "Bat Mask effect", description: "A black bat mask worn by your avatar itself — pointed ears on top of the circle and the mask fixed across it, all one piece. Free for every player.", scope: "personal", kind: "effect", value: "shadow" },
  { id: "effect-neon-pulse", name: "Neon Halo effect", description: "A pink-and-teal halo resting on top of your avatar circle, sitting on it like a real halo — attached, not floating away from it. Free for every player.", scope: "personal", kind: "effect", value: "neon-pulse" },
  { id: "effect-sunset-haze", name: "Sunset Cap effect", description: "A sunset-orange cap your avatar wears — the dome and brim are part of the circle itself. Free for every player.", scope: "personal", kind: "effect", value: "sunset-haze" },
  { id: "effect-fire", name: "Inferno Mohawk effect — Premium", description: "Premium exclusive — an animated flame mohawk rooted in the top of your avatar circle: the flames grow out of the circle itself and flicker while attached to it. Free members cannot use this effect.", scope: "personal", kind: "effect", value: "fire", premiumOnly: true },
  { id: "effect-lightning", name: "Storm Helmet effect — Premium", description: "Premium exclusive — a storm helmet your avatar wears: a metal dome fixed over the top of the circle with a lightning crest and sparks at its rivets. Free members cannot use this effect.", scope: "personal", kind: "effect", value: "lightning", premiumOnly: true },
  { id: "effect-neon-surge", name: "Dragon Horns effect — Premium", description: "Premium exclusive — big curved dragon horns rooted into your avatar circle with gold bands and a centre gem, all one piece with the avatar. Free members cannot use this effect.", scope: "personal", kind: "effect", value: "neon-surge", premiumOnly: true },
  // -- Badges (personal) — 5 free + 3 Premium --
  { id: "badge-rookie", name: "Rookie profile badge", description: "A Rookie badge shown on your profile and in the player directory. Free for every player.", scope: "personal", kind: "badge", value: "Rookie" },
  { id: "badge-crew", name: "Crew Member profile badge", description: "A Crew Member badge shown on your profile and in the player directory. Free for every player.", scope: "personal", kind: "badge", value: "Crew Member" },
  { id: "badge-season", name: "Season Contender profile badge", description: "A Season Contender badge shown on your profile and in the player directory. Free for every player.", scope: "personal", kind: "badge", value: "Season Contender" },
  { id: "badge-season-champion", name: "Season Champion profile badge", description: "A Season Champion badge shown on your profile and in the player directory. Free for every player.", scope: "personal", kind: "badge", value: "Season Champion" },
  { id: "badge-vice-legend", name: "Vice Legend profile badge", description: "A Vice Legend badge shown on your profile and in the player directory. Free for every player.", scope: "personal", kind: "badge", value: "Vice Legend" },
  { id: "badge-premium", name: "Premium Member profile badge", description: "The custom Premium badge — included with Premium only, never sold separately. Shows on your profile and in the player directory while equipped.", scope: "personal", kind: "badge", value: "Premium Member", premiumOnly: true },
  { id: "badge-vice-elite", name: "Vice Elite profile badge — Premium", description: "Premium exclusive — a Vice Elite badge for your profile. Free members cannot get this badge.", scope: "personal", kind: "badge", value: "Vice Elite", premiumOnly: true },
  { id: "badge-neon-legend", name: "Neon Legend profile badge — Premium", description: "Premium exclusive — a Neon Legend badge for your profile. Free members cannot get this badge.", scope: "personal", kind: "badge", value: "Neon Legend", premiumOnly: true },
  // -- Calling Cards / Banners (personal) — 5 free + 3 Premium. The
  // calling card IS the profile banner: one merged section, no separate
  // banner colours or banner styles exist anymore. Free cards are
  // static; the 3 Premium cards are ANIMATED (moving smoke, leaves,
  // fire). Challenge cards live in CHALLENGE_CARD_ITEMS below — earned,
  // never for sale, and not part of the 5 + 3 catalogue.
  { id: "card-vice-nights", name: "Vice Nights calling card", description: "A bold neon Vice Nights calling card — hot pink skyline energy. It is also your profile banner. Free for every player.", scope: "personal", kind: "callingCard", value: "vice-nights" },
  { id: "card-street-heat", name: "Street Heat calling card", description: "A Street Heat calling card — flames and asphalt attitude. It is also your profile banner. Free for every player.", scope: "personal", kind: "callingCard", value: "street-heat" },
  { id: "card-palm-reaper", name: "Palm Reaper calling card", description: "A Palm Reaper calling card — a skull wearing palm shades, Vice style. It is also your profile banner. Free for every player.", scope: "personal", kind: "callingCard", value: "palm-reaper" },
  { id: "card-keys-runner", name: "Keys Runner calling card", description: "A Keys Runner calling card — teal speed across the causeway. It is also your profile banner. Free for every player.", scope: "personal", kind: "callingCard", value: "keys-runner" },
  { id: "card-skull-strip", name: "Skull Strip calling card", description: "A Skull Strip calling card — a wall of skulls in neon pink. It is also your profile banner. Free for every player.", scope: "personal", kind: "callingCard", value: "skull-strip" },
  { id: "card-leonida-haze", name: "Vice Haze calling card — Premium", description: "Premium exclusive — an ANIMATED Vice Haze calling card: neon-green leaves and thick smoke drifting across a black card, COD weed-card style, drawn original for ViceSunshine. It is also your profile banner. Free members cannot use this card.", scope: "personal", kind: "callingCard", value: "leonida-haze", premiumOnly: true },
  { id: "card-armed-palms", name: "Hydro Vice calling card — Premium", description: "Premium exclusive — an ANIMATED Hydro Vice calling card: glowing green leaves swaying over a dark hydroponic glow, COD weed-card style, drawn original for ViceSunshine. It is also your profile banner. Free members cannot use this card.", scope: "personal", kind: "callingCard", value: "armed-palms", premiumOnly: true },
  { id: "card-club-leonida", name: "Magic Palms calling card — Premium", description: "Premium exclusive — an ANIMATED Magic Palms calling card: a skull with glowing eyes wreathed in moving flame and palm leaves, COD Dark-Ops style, drawn original for ViceSunshine. It is also your profile banner. Free members cannot use this card.", scope: "personal", kind: "callingCard", value: "club-leonida", premiumOnly: true },
  // -- Themes (personal) — 5 free + 3 Premium --
  { id: "theme-vice-pink", name: "Vice Pink theme", description: "The classic Vice Pink accent theme, shown on your profile and posts. Free for every player.", scope: "personal", kind: "theme", value: "#ff2e88" },
  { id: "theme-neon-teal", name: "Neon Teal theme", description: "A Neon Teal accent theme, shown on your profile and posts. Free for every player.", scope: "personal", kind: "theme", value: "#2dd4bf" },
  { id: "theme-neon-purple", name: "Neon Purple theme", description: "A Neon Purple accent theme, shown on your profile and posts. Free for every player.", scope: "personal", kind: "theme", value: "#a855f7" },
  { id: "theme-sunset-amber", name: "Sunset Amber theme", description: "A Sunset Amber accent theme, shown on your profile and posts. Free for every player.", scope: "personal", kind: "theme", value: "#e8a33d" },
  { id: "theme-sunset-orange", name: "Sunset Orange theme", description: "A Sunset Orange accent theme, shown on your profile and posts. Free for every player.", scope: "personal", kind: "theme", value: "#ff7043" },
  { id: "theme-gold-vice", name: "Gold Vice theme — Premium", description: "Premium exclusive — a Gold Vice accent theme, shown on your profile and posts. Free members cannot use this theme.", scope: "personal", kind: "theme", value: "#FFD166", premiumOnly: true },
  { id: "theme-ice-vice", name: "Ice Vice theme — Premium", description: "Premium exclusive — an Ice Vice accent theme, shown on your profile and posts. Free members cannot use this theme.", scope: "personal", kind: "theme", value: "#7DF9FF", premiumOnly: true },
  { id: "theme-ultraviolet-vice", name: "Ultraviolet Vice theme — Premium", description: "Premium exclusive — an Ultraviolet Vice accent theme, shown on your profile and posts. Free members cannot use this theme.", scope: "personal", kind: "theme", value: "#9B5DE5", premiumOnly: true },
  // -- Clan Emblems (clan) — 5 free + 3 Premium --
  { id: "emblem-sunset", name: "Sunset emblem", description: "A sunset-mark crew emblem for your crew card and crew home. Free for every crew.", scope: "clan", kind: "emblem", value: "sunset" },
  { id: "emblem-crown-gold", name: "Gold Crown emblem", description: "A gold crown crew emblem for your crew card and crew home. Free for every crew.", scope: "clan", kind: "emblem", value: "crown" },
  { id: "emblem-serpent", name: "Serpent emblem", description: "A serpent crew emblem for your crew card and crew home. Free for every crew.", scope: "clan", kind: "emblem", value: "serpent" },
  { id: "emblem-diamond", name: "Diamond emblem", description: "A diamond crew emblem for your crew card and crew home. Free for every crew.", scope: "clan", kind: "emblem", value: "diamond" },
  { id: "emblem-wave", name: "Wave emblem", description: "A wave crew emblem for your crew card and crew home — Leonida coastline energy. Free for every crew.", scope: "clan", kind: "emblem", value: "wave" },
  { id: "emblem-vice-crest", name: "Vice Crest crew emblem — Premium", description: "The custom Premium crew emblem — a gold Vice Crest on your crew card and crew home. Included with Premium only, never sold separately: the Leader or Co-Leader equipping it must have Premium.", scope: "clan", kind: "emblem", value: "vicecrest", premiumOnly: true },
  { id: "emblem-eclipse", name: "Eclipse emblem — Premium", description: "Premium exclusive — an eclipse crew emblem for your crew card and crew home. The Leader or Co-Leader equipping it must have Premium.", scope: "clan", kind: "emblem", value: "eclipse", premiumOnly: true },
  { id: "emblem-royal-palm", name: "Royal Palm emblem — Premium", description: "Premium exclusive — a royal palm crew emblem for your crew card and crew home. The Leader or Co-Leader equipping it must have Premium.", scope: "clan", kind: "emblem", value: "royal-palm", premiumOnly: true },
  // -- Clan Colours (clan) — 5 free + 3 Premium --
  { id: "color-classic-teal", name: "Classic Teal crew colour", description: "Classic teal (#2DD4BF) as your crew colour. Free for every crew.", scope: "clan", kind: "color", value: "#2DD4BF" },
  { id: "color-gold", name: "Gold crew colour", description: "Gold (#FFD166) as your crew colour, applied to your crew card and home. Free for every crew.", scope: "clan", kind: "color", value: "#FFD166" },
  { id: "color-ice", name: "Ice crew colour", description: "Ice blue (#7DF9FF) as your crew colour. Free for every crew.", scope: "clan", kind: "color", value: "#7DF9FF" },
  { id: "color-ultraviolet", name: "Ultraviolet crew colour", description: "Ultraviolet (#9B5DE5) as your crew colour. Free for every crew.", scope: "clan", kind: "color", value: "#9B5DE5" },
  { id: "color-vice-pink", name: "Vice Pink crew colour", description: "Vice pink (#FF2E88) as your crew colour. Free for every crew.", scope: "clan", kind: "color", value: "#FF2E88" },
  { id: "color-molten", name: "Molten Orange crew colour — Premium", description: "Premium exclusive — molten orange (#FF7A00) as your crew colour. The Leader or Co-Leader equipping it must have Premium.", scope: "clan", kind: "color", value: "#FF7A00", premiumOnly: true },
  { id: "color-emerald-premium", name: "Emerald crew colour — Premium", description: "Premium exclusive — emerald green (#39E07A) as your crew colour. The Leader or Co-Leader equipping it must have Premium.", scope: "clan", kind: "color", value: "#39E07A", premiumOnly: true },
  { id: "color-midnight-violet", name: "Midnight Violet crew colour — Premium", description: "Premium exclusive — midnight violet (#5B2A86) as your crew colour. The Leader or Co-Leader equipping it must have Premium.", scope: "clan", kind: "color", value: "#5B2A86", premiumOnly: true },
  // -- Clan Calling Cards / Banners (clan) — 5 free + 3 Premium. The
  // clan calling card IS the clan banner on the clan home header.
  { id: "card-clan-vice", name: "Vice Nights crew calling card", description: "A bold neon Vice Nights calling card for your crew home — it is also your crew banner. Free for every crew.", scope: "clan", kind: "callingCard", value: "clan-vice" },
  { id: "card-clan-heat", name: "Street Heat crew calling card", description: "A Street Heat calling card for your crew home — flames and asphalt. It is also your crew banner. Free for every crew.", scope: "clan", kind: "callingCard", value: "clan-heat" },
  { id: "card-clan-skull", name: "Skull Strip crew calling card", description: "A Skull Strip calling card for your crew home — a wall of skulls in neon pink. It is also your crew banner. Free for every crew.", scope: "clan", kind: "callingCard", value: "skull-strip" },
  { id: "card-clan-keys", name: "Keys Runner crew calling card", description: "A Keys Runner calling card for your crew home — teal speed across the causeway. It is also your crew banner. Free for every crew.", scope: "clan", kind: "callingCard", value: "keys-runner" },
  { id: "card-clan-reaper", name: "Palm Reaper crew calling card", description: "A Palm Reaper calling card for your crew home — a skull wearing palm shades. It is also your crew banner. Free for every crew.", scope: "clan", kind: "callingCard", value: "palm-reaper" },
  { id: "card-clan-haze", name: "Vice Haze crew calling card — Premium", description: "Premium exclusive — an ANIMATED Vice Haze calling card for your crew home: drifting smoke and neon-green leaves. It is also your crew banner. The Leader or Co-Leader equipping it must have Premium.", scope: "clan", kind: "callingCard", value: "clan-haze", premiumOnly: true },
  { id: "card-clan-dead", name: "Dead Palms crew calling card — Premium", description: "Premium exclusive — an ANIMATED Dead Palms calling card for your crew home: smoke rolling past dead palms and a skull. It is also your crew banner. The Leader or Co-Leader equipping it must have Premium.", scope: "clan", kind: "callingCard", value: "clan-dead", premiumOnly: true },
  { id: "card-clan-inferno", name: "Inferno crew calling card — Premium", description: "Premium exclusive — an ANIMATED Inferno calling card for your crew home: a full wall of moving flame. It is also your crew banner. The Leader or Co-Leader equipping it must have Premium.", scope: "clan", kind: "callingCard", value: "inferno", premiumOnly: true },
];

function cosmeticItem(id: string): CosmeticItemDef | undefined {
  return COSMETIC_ITEMS.find((i) => i.id === id);
}

// ---- Clan Awards — earned, never for sale ----
// A SEPARATE system from the free Customise catalogue and from credit
// rewards. Clan Awards are exclusive clan cosmetics (a seasonal emblem
// and milestone banner styles) granted to the WHOLE clan
// when the clan hits a milestone together. They are deliberately NOT in
// COSMETIC_ITEMS: they are never for sale, cannot be equipped before
// they are earned, and cannot be owned by an individual — only by a
// clan, as a team. (Event Rewards are the
// other system: Vice Credits paid to clan wallets — see closeSeason
// and hostConfirmEvent.)
const AWARD_ITEMS: CosmeticItemDef[] = [
  { id: "emblem-phoenix", name: "Phoenix emblem", description: "Crew Award — the exclusive emblem for finishing a season ranked #1 on a board. Earned by the whole crew, never for sale.", scope: "clan", kind: "emblem", value: "phoenix" },
  { id: "award-banner-founders", name: "Founders calling card banner", description: "Crew Award — an exclusive gold Founders calling card (it is also the crew banner) for reaching 10 members. Earned by the whole crew, never for sale.", scope: "clan", kind: "callingCard", value: "founders" },
];
function awardItem(id: string): CosmeticItemDef | undefined {
  return AWARD_ITEMS.find((i) => i.id === id);
}
// Any cosmetic a clan can equip: a free catalogue customisation, or a
// Clan Award it earned.
// ---- Challenge Calling Cards — earned, never for sale ----
// COD Dark-Ops style: a small set of personal calling cards that are
// NOT in the free/Premium catalogue (so the merged Calling Card /
// Banner section stays exactly 5 free + 3 Premium). Each unlocks by
// completing a challenge counted automatically from in-app activity
// only — the same rule as Rank Points. Locked cards cannot be
// equipped (enforced in equipCosmetic); progress is reported by
// getCustomise so the Customise section can show it.
export interface ChallengeCardDef extends CosmeticItemDef {
  challenge: string;
  metric: "level" | "feedPosts" | "eventsGoing";
  target: number;
}

const CHALLENGE_CARD_ITEMS: ChallengeCardDef[] = [
  { id: "card-challenge-dark-vice", name: "Dark Vice calling card — Challenge", description: "Challenge card — an animated black-ops card: a skull with glowing red eyes in drifting smoke. Unlock it by reaching ViceSunshine Level 5. Earned, never for sale.", scope: "personal", kind: "callingCard", value: "dark-vice", challenge: "Reach ViceSunshine Level 5", metric: "level", target: 5 },
  { id: "card-challenge-skull-harvest", name: "Skull Harvest calling card — Challenge", description: "Challenge card — an animated row of skulls wreathed in swaying neon-green leaves. Unlock it by making 10 Feed posts. Earned, never for sale.", scope: "personal", kind: "callingCard", value: "skull-harvest", challenge: "Make 10 Feed posts", metric: "feedPosts", target: 10 },
  { id: "card-challenge-vicestronaut", name: "Vicestronaut calling card — Challenge", description: "Challenge card — an animated astronaut skull with leaves drifting inside a glowing visor, high over Leonida. Unlock it by RSVPing Going to 5 community events. Earned, never for sale.", scope: "personal", kind: "callingCard", value: "vicestronaut", challenge: "RSVP Going to 5 community events", metric: "eventsGoing", target: 5 },
];

function challengeCardOf(id: string): ChallengeCardDef | undefined {
  return CHALLENGE_CARD_ITEMS.find((i) => i.id === id);
}

async function challengeProgress(
  ctx: Ctx,
  playerKey: string,
): Promise<Map<string, { current: number; unlocked: boolean }>> {
  const db = ctx.db<typeof schema>();
  const events = await db.select().from(schema.rankPointEvents);
  const level = playerLevelFromPoints(personalPointsOf(events, playerKey)).level;
  const posts = (await db.select().from(schema.feedPosts).where(eq(schema.feedPosts.authorKey, playerKey))).length;
  const going = (await db.select().from(schema.rsvps).where(eq(schema.rsvps.playerKey, playerKey))).filter((r) => r.status === "Going").length;
  const values: Record<ChallengeCardDef["metric"], number> = { level, feedPosts: posts, eventsGoing: going };
  const out = new Map<string, { current: number; unlocked: boolean }>();
  for (const c of CHALLENGE_CARD_ITEMS) {
    const current = values[c.metric];
    out.set(c.id, { current, unlocked: current >= c.target });
  }
  return out;
}

// ---- Season Challenges + auto-generated season calling cards ----
// Every season (a calendar month; Season 1 = November 2026, launch
// month) has its own set of WEB-BASED-ONLY challenges. Every challenge
// is counted AUTOMATICALLY from the player's own ViceSunshine records
// — RSVPs, Feed posts, LFG teams, likes received, clan
// recruits, lifetime XP level — never from anything inside GTA VI,
// never from uploads or self-reports. Targets RISE every season
// (events: 5 in Season 1, 10 in Season 2, 15 in Season 3, …; the level
// challenge climbs to Level 10, then Level 20, and beyond).
//
// Each completed challenge unlocks that season's calling card for it,
// automatically (the owned_items row is granted lazily on read — the
// same pattern as Clan Awards). The season's card set is AUTO-
// GENERATED: the definitions (theme, names, palette, scene) are
// generated deterministically from the season number, and the artwork
// itself is painted by generate_media into owned blobs (see
// generateSeasonCardArtFor, driven by seedArtwork / refreshSeasonCards
// on a schedule). Every season's set is a higher DESIGN TIER than the
// last — more layers, more animation, richer art prompts — so each
// season's auto-generated cards are better than the season before,
// in the same loved COD-style ViceSunshine look (dark cards, skulls,
// neon-green leaves, fire, smoke).
type SeasonMetric = "events" | "feedPosts" | "lfg" | "likes" | "recruits" | "level";
interface SeasonChallengeDef {
  metric: SeasonMetric;
  title: string;
  challenge: string;
  cardName: string;
  scene: string;
}
const SEASON_THEMES = [
  "Vice Nights", "Neon Storm", "Haze Empire", "Skull Dynasty",
  "Solar Vice", "Midnight Empire", "Emerald Reign", "Ultraviolet Kings",
  "Golden Deluge", "Phantom Coast", "Neon Renaissance", "Vice Ascendant",
];
function seasonThemeOf(n: number): string {
  return SEASON_THEMES[n - 1] ?? `Vice Ascendant ${n}`;
}
function seasonNumberOfKey(key: string): number {
  const [y = 2026, m = 11] = key.split("-").map(Number);
  return Math.max(1, (y - 2026) * 12 + (m - 11) + 1);
}
function seasonKeyForNumber(n: number): string {
  const idx = 2026 * 12 + 10 + (Math.max(1, n) - 1); // 2026-11 = Season 1
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}
function seasonLevelTarget(n: number): number {
  const table = [3, 5, 7, 10, 12, 15, 18, 20];
  return table[n - 1] ?? 20 + 3 * (n - table.length);
}
function seasonChallengesOf(n: number): SeasonChallengeDef[] {
  const s = Math.max(1, n);
  return [
    { metric: "events", title: "Showrunner", challenge: `RSVP Going to ${5 * s} community events this season`, cardName: "Headliner", scene: "skyline" },
    { metric: "feedPosts", title: "Firestarter", challenge: `Make ${5 * s} Feed posts this season`, cardName: "Firestarter", scene: "flames" },
    { metric: "likes", title: "Crowd Favourite", challenge: `Get ${25 * s} likes on your Feed posts this season`, cardName: "Crowd Favourite", scene: "magic" },
    { metric: "recruits", title: "Recruiter", challenge: `${2 + 2 * (s - 1)} members recruited into your crew this season`, cardName: "Recruiter", scene: "founders" },
    { metric: "level", title: "Ascendant", challenge: `Reach ViceSunshine Level ${seasonLevelTarget(s)}`, cardName: "Ascendant", scene: "vicestronaut" },
  ];
}
function seasonTargetOf(def: SeasonChallengeDef, n: number): number {
  const s = Math.max(1, n);
  switch (def.metric) {
    case "events": return 5 * s;
    case "feedPosts": return 5 * s;
    case "lfg": return 3 + 2 * (s - 1);
    case "likes": return 25 * s;
    case "recruits": return 2 + 2 * (s - 1);
    case "level": return seasonLevelTarget(s);
  }
}
// What the auto-generation adds at each design tier — every season is
// visibly richer than the one before.
function seasonTierPerks(n: number): string[] {
  const perks = ["Bold COD-style card in the ViceSunshine neon look — skulls, neon-green leaves, fire and smoke"];
  if (n >= 2) perks.push("Animated this season: drifting smoke and swaying leaves");
  if (n >= 3) perks.push("Tier 3 adds flickering flames and glowing skull eyes");
  if (n >= 4) perks.push("Tier 4 adds a shimmer sweep and layered depth");
  if (n >= 5) perks.push("Tier 5 adds a dual-layer parallax scene and a richer, deeper palette");
  if (n >= 6) perks.push(`Tier ${n}: maximum-detail auto-generated artwork — more layers, finer detail and stronger light than Season ${n - 1}`);
  return perks;
}
function seasonCardItemId(n: number, metric: SeasonMetric): string {
  return `card-season-${n}-${metric}`;
}
function seasonCardValue(n: number, metric: SeasonMetric): string {
  return `s${n}-${metric}`;
}
function seasonCardItem(n: number, def: SeasonChallengeDef): CosmeticItemDef {
  return {
    id: seasonCardItemId(n, def.metric),
    name: `Season ${n} ${seasonThemeOf(n)} ${def.cardName} calling card`,
    description: `Season ${n} challenge reward — an auto-generated Tier ${n} calling card in the ${seasonThemeOf(n)} set, generated fresh for this season${n > 1 ? ` and richer than Season ${n - 1}'s designs` : " — the first auto-generated season set"}. It is also your profile banner. Unlock it automatically: ${def.challenge}. Earned, never for sale.`,
    scope: "personal",
    kind: "callingCard",
    value: seasonCardValue(n, def.metric),
  };
}
function seasonCardInfo(id: string): { n: number; def: SeasonChallengeDef; item: CosmeticItemDef } | undefined {
  const m = id.match(/^card-season-(\d+)-(\w+)$/);
  if (!m) return undefined;
  const n = Number(m[1] ?? 0);
  const def = seasonChallengesOf(n).find((d) => d.metric === m[2]);
  if (!def || n < 1) return undefined;
  return { n, def, item: seasonCardItem(n, def) };
}

// Season-scoped automatic progress for one player: every value is
// counted from rows ViceSunshine itself recorded in that season's
// month — except Level, which is the player's lifetime XP level.
async function seasonMetricValues(
  ctx: Ctx,
  playerKey: string,
  seasonKey: string,
): Promise<Record<SeasonMetric, number>> {
  const db = ctx.db<typeof schema>();
  const [y = 2026, m = 11] = seasonKey.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  const inSeason = (d: Date) => d >= start && d < end;
  const rsvps = await db.select().from(schema.rsvps).where(eq(schema.rsvps.playerKey, playerKey));
  const events = rsvps.filter((r) => r.status === "Going" && inSeason(r.createdAt)).length;
  const posts = await db.select().from(schema.feedPosts).where(eq(schema.feedPosts.authorKey, playerKey));
  const feedPosts = posts.filter((r) => r.repostOfId === 0 && inSeason(r.createdAt)).length;
  const myPostIds = new Set(posts.map((p) => p.id));
  const reactions = await db.select().from(schema.feedReactions);
  const likes = reactions.filter((r) => myPostIds.has(r.postId) && r.playerKey !== playerKey && inSeason(r.createdAt)).length;
  const formed = (await db.select().from(schema.lfgPosts).where(eq(schema.lfgPosts.authorKey, playerKey)))
    .filter((r) => inSeason(r.createdAt)).map((r) => r.id);
  const joined = (await db.select().from(schema.lfgMembers).where(eq(schema.lfgMembers.playerKey, playerKey)))
    .filter((r) => inSeason(r.createdAt)).map((r) => r.lfgId);
  const lfg = new Set([...formed, ...joined]).size;
  const myMemberships = await db.select().from(schema.clanMembers).where(eq(schema.clanMembers.playerKey, playerKey));
  const myClanIds = new Set(myMemberships.map((r) => r.clanId));
  let recruits = 0;
  if (myClanIds.size > 0) {
    const allMembers = await db.select().from(schema.clanMembers);
    recruits = allMembers.filter((r) => myClanIds.has(r.clanId) && r.playerKey !== playerKey && inSeason(r.joinedAt)).length;
  }
  const pointEvents = await db.select().from(schema.rankPointEvents);
  const level = playerLevelFromPoints(personalPointsOf(pointEvents, playerKey)).level;
  return { events, feedPosts, lfg, likes, recruits, level };
}

async function seasonChallengeProgress(
  ctx: Ctx,
  playerKey: string,
  seasonKey: string,
): Promise<Map<string, { current: number; target: number; unlocked: boolean }>> {
  const n = seasonNumberOfKey(seasonKey);
  const values = await seasonMetricValues(ctx, playerKey, seasonKey);
  const out = new Map<string, { current: number; target: number; unlocked: boolean }>();
  for (const def of seasonChallengesOf(n)) {
    const target = seasonTargetOf(def, n);
    const current = values[def.metric];
    out.set(seasonCardItemId(n, def.metric), { current, target, unlocked: current >= target });
  }
  return out;
}

// Grants the owned_items rows for any season challenges the player
// has completed (idempotent — unlocking is automatic, there is no
// claim step). Returns the item ids unlocked for that season.
async function grantSeasonUnlocks(
  ctx: Ctx,
  playerKey: string,
  seasonKey: string,
): Promise<Set<string>> {
  const db = ctx.db<typeof schema>();
  const progress = await seasonChallengeProgress(ctx, playerKey, seasonKey);
  const owned = await db.select().from(schema.ownedItems);
  const mine = new Set(owned.filter((o) => o.ownerType === "personal" && o.ownerId === playerKey).map((o) => o.itemId));
  const unlocked = new Set<string>();
  for (const [itemId, p] of progress) {
    if (!p.unlocked) continue;
    unlocked.add(itemId);
    if (!mine.has(itemId)) {
      await db.insert(schema.ownedItems).values({ ownerType: "personal", ownerId: playerKey, itemId, equipped: 0 });
    }
  }
  return unlocked;
}

// Auto-generates ONE season calling card's artwork: an original
// painted banner in the loved ViceSunshine COD-card style, with the
// design brief escalating every season so each season's set is
// richer than the last. Stored as an owned blob; the meta key is the
// record, so a card is generated exactly once per season.
const SEASON_CARD_ART_BRIEFS: Record<SeasonMetric, string> = {
  events: "a neon Vice City skyline at night with a cheering crowd silhouette and marquee lights",
  feedPosts: "bold flames and a wall of skulls, the loudest card on the strip",
  lfg: "a crew of silhouetted players beside two muscle cars under neon signs, speed lines",
  likes: "a golden skull with glowing eyes wreathed in flame and neon-green leaves, crowd-favourite shine",
  recruits: "a gold founders emblem scene — a crowned skull with palm leaves, earned-together pride",
  level: "an astronaut skull with neon-green leaves drifting inside a glowing visor, high over Leonida",
};
function seasonArtTierBrief(n: number): string {
  if (n <= 1) return "Design tier 1: bold flat neon shapes, clean and striking, strong silhouette";
  if (n === 2) return "Design tier 2: add drifting smoke, layered leaves and deeper shadows over the tier 1 look";
  if (n === 3) return "Design tier 3: add flickering flame detail, glowing eyes and richer contrast over tier 2";
  if (n === 4) return "Design tier 4: add shimmering light accents, layered parallax depth and cinematic lighting over tier 3";
  return `Design tier ${n}: maximum detail — layered parallax, fine smoke and flame detail, premium cinematic finish, strictly richer and better than tier ${n - 1}`;
}
async function generateSeasonCardArtFor(ctx: Ctx, n: number, def: SeasonChallengeDef): Promise<boolean> {
  const value = seasonCardValue(n, def.metric);
  try {
    const media = await ctx.tool.generate_media(
      `Paint a wide calling-card banner: ${SEASON_CARD_ART_BRIEFS[def.metric]}. Season ${n} theme "${seasonThemeOf(n)}". ${seasonArtTierBrief(n)}. Original ViceSunshine fan artwork in the COD calling-card style — dark background, hot pink, neon purple and teal with neon-green leaves, skulls, fire and smoke. No text, no letters, no logos, no watermark, not a copy of any existing artwork.`,
      { key: `season-card-art/${value}`, orientation: "landscape" },
    );
    await setMeta(ctx, `season-card-art:${value}`, media.blobKey);
    return true;
  } catch {
    return false;
  }
}
async function seasonCardArtUrls(ctx: Ctx, n: number): Promise<Map<string, string>> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.meta);
  const out = new Map<string, string>();
  for (const def of seasonChallengesOf(n)) {
    const value = seasonCardValue(n, def.metric);
    const row = rows.find((r) => r.key === `season-card-art:${value}` && r.value);
    if (row) {
      try {
        out.set(value, await ctx.blobs.getUrl(row.value));
      } catch { /* art renders as the CSS scene instead */ }
    }
  }
  return out;
}

function itemDef(id: string): CosmeticItemDef | undefined {
  return cosmeticItem(id) ?? awardItem(id) ?? challengeCardOf(id) ?? seasonCardInfo(id)?.item;
}
const CLAN_AWARDS: { id: string; name: string; requirement: string; itemId: string }[] = [
  { id: "members-10", name: "Growing Crew", requirement: "Reach 10 members", itemId: "award-banner-founders" },
  { id: "season-champions", name: "Season Champions", requirement: "Finish a season ranked #1 on any board", itemId: "emblem-phoenix" },
];
// Grants any Clan Awards the clan has newly earned (idempotent — the
// owned_items row is the record). Called lazily when a clan home is
// read, with the clan's real member count.
async function applyClanAwards(
  ctx: Ctx,
  clanId: number,
  memberCount: number,
): Promise<void> {
  const db = ctx.db<typeof schema>();
  const owned = await db.select().from(schema.ownedItems);
  const has = (itemId: string) =>
    owned.some((o) => o.ownerType === "clan" && o.ownerId === String(clanId) && o.itemId === itemId);
  const grant = async (itemId: string, label: string) => {
    if (has(itemId)) return;
    await db.insert(schema.ownedItems).values({ ownerType: "clan", ownerId: String(clanId), itemId, equipped: 0 });
    await logActivity(ctx, clanId, "ViceSunshine", "earned a Crew Award:", label, "Crew Awards are earned by the whole crew — never for sale");
  };
  if (memberCount >= 10) await grant("award-banner-founders", "Founders calling card banner — 10 members");
  const wins = await db.select().from(schema.seasonWinners).where(eq(schema.seasonWinners.clanId, clanId));
  if (wins.some((w) => w.rank === 1)) await grant("emblem-phoenix", "Phoenix emblem — Season Champions");
}

// ---- Settings, privacy and Refer a Friend ----
// Referral codes are derived deterministically from the player key
// (stable across reads) and also stored on the profile when Settings
// is opened, so a code can be looked up from the code alone.
const REFERRAL_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function referralCodeFor(playerKey: string): string {
  let h = 2166136261;
  for (let i = 0; i < playerKey.length; i++) {
    h ^= playerKey.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let out = "";
  let x = h >>> 0;
  for (let i = 0; i < 6; i++) {
    out += REFERRAL_ALPHABET[x % REFERRAL_ALPHABET.length];
    x = Math.floor(x / REFERRAL_ALPHABET.length) * 31 + ((h >>> (i * 3)) & 0xff) + 7;
  }
  return `VV-${out}`;
}
async function findByReferralCode(
  ctx: Ctx,
  code: string,
): Promise<typeof schema.profiles.$inferSelect | null> {
  const db = ctx.db<typeof schema>();
  const profs = await db.select().from(schema.profiles);
  return profs.find((p) => (p.referralCode || referralCodeFor(p.playerKey)) === code) ?? null;
}
// Applies a referral once: referredBy is set a single time (one use
// per friend). The reward goes to the REFERRER (owner's rule, Nov 19
// 2026 — replacing the old 10% Premium discount): REFERRAL_CREDITS
// Vice Credits land in their wallet — exactly the price of one extra
// community event beyond the weekly limit — plus +15 XP (Rank
// Points) for the recruit, counted automatically by recordPoints
// like every other in-app reward. The referralDiscount column is
// legacy from the discount era and is no longer granted or read.
async function applyReferralInternal(
  ctx: Ctx,
  me: typeof schema.profiles.$inferSelect,
  rawCode: string,
): Promise<{ ok: boolean; message: string }> {
  const code = rawCode.trim().toUpperCase();
  if (!code) return { ok: false, message: "Enter a referral code first." };
  if (me.referredBy) {
    return { ok: false, message: "You have already used a referral code — one per player." };
  }
  if ((me.referralCode || referralCodeFor(me.playerKey)) === code) {
    return { ok: false, message: "That's your own referral code — share it with a friend instead." };
  }
  const referrer = await findByReferralCode(ctx, code);
  if (!referrer) return { ok: false, message: "That referral code doesn't match any ViceSunshine player." };
  const db = ctx.db<typeof schema>();
  await db
    .update(schema.profiles)
    .set({ referredBy: code })
    .where(eq(schema.profiles.id, me.id));
  if (!referrer.referralCode) {
    await db
      .update(schema.profiles)
      .set({ referralCode: referralCodeFor(referrer.playerKey) })
      .where(eq(schema.profiles.id, referrer.id));
  }
  // The referrer's reward: 200 Vice Credits (one extra community
  // event) plus the +15 XP recruit points. recordPoints also pays
  // its points out as credits, like every counted in-app action.
  await creditPersonalWallet(
    ctx,
    referrer.playerKey,
    REFERRAL_CREDITS,
    `Referral bonus — ${me.gamertag} joined with your code`,
  );
  await recordPoints(ctx, {
    playerKey: referrer.playerKey,
    gamertag: referrer.gamertag,
    targetClanId: null,
    points: POINT_RATES.recruit,
    source: "recruit",
    sourceRef: `referral:${me.playerKey}`,
    reason: `${me.gamertag} joined ViceSunshine with your referral code`,
    verifiedBy: "system",
  });
  return {
    ok: true,
    message: `Referral applied — ${referrer.gamertag} earned ${REFERRAL_CREDITS} Vice Credits and +${POINT_RATES.recruit} XP for inviting you. Welcome to ViceSunshine.`,
  };
}
async function blockedKeysFor(ctx: Ctx, playerKey: string): Promise<Set<string>> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.blockedUsers)
    .where(eq(schema.blockedUsers.playerKey, playerKey));
  return new Set(rows.map((r) => r.blockedKey));
}

// The reverse of blockedKeysFor: the set of players who have blocked
// THIS player. Blocking works both ways in ViceSunshine — a blocked
// player cannot see or interact with the person who blocked them.
async function blockedByKeysFor(ctx: Ctx, playerKey: string): Promise<Set<string>> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.blockedUsers)
    .where(eq(schema.blockedUsers.blockedKey, playerKey));
  return new Set(rows.map((r) => r.playerKey));
}

// Sign-in gate for every basic action (post, like, comment, save,
// follow, RSVP, story, account saves): the device key must belong to
// a real saved account. Signed-out visitors can look, but they
// cannot DO anything until they create an account or log in.
async function requireProfile(ctx: Ctx, playerKey: string) {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.profiles)
    .where(eq(schema.profiles.playerKey, playerKey));
  if (!rows[0]) {
    throw new Error("You need an account for that — create your account or log in first, then try again.");
  }
  return rows[0];
}

// The set of players an author has hidden their stories from
// (Settings → Permissions → Hide story).
// Username-change tracking for the About account sheet: when a
// rename actually changes the gamertag (case-insensitive compare),
// the count goes up by one and the time is stamped. Account
// creation is not a change, and renames from before this tracking
// existed are unknowable — the count honestly starts at 0.
function usernameChangeFields(
  row: { gamertag: string; usernameChanges: number; lastUsernameChangeAt: Date | null },
  newTag: string,
): { usernameChanges?: number; lastUsernameChangeAt?: Date } {
  if (row.gamertag.trim().toLowerCase() === newTag.trim().toLowerCase()) return {};
  return { usernameChanges: (row.usernameChanges ?? 0) + 1, lastUsernameChangeAt: new Date() };
}

// The username / gamertag is permanent (owner's direction): it is
// chosen when the account is created and can never be changed
// afterwards. Every save path that carries a gamertag for an
// existing profile runs this check; a different gamertag (beyond
// letter case) is refused.
function assertGamertagPermanent(current: string, next: string): void {
  if (current.trim().toLowerCase() !== next.trim().toLowerCase()) {
    throw new Error("Your username is permanent — it was set when your account was created and can't be changed. Your display name is the one you can change.");
  }
}

// Display name / clan tag change rule (owner's direction): each
// can be changed once every 30 days; after a change, the next one
// unlocks 30 days later. Premium members can change either any
// time. Setting a value for the first time (the stored value is
// empty) is free and does not start the clock — the clock starts
// at the first change away from a value the player already had.
const NAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
function nameChangeGate(
  label: "display name" | "clan tag",
  current: string,
  next: string,
  changedAt: Date | null,
  premium: boolean,
): { blocked: string | null; stamp: boolean } {
  const cur = current.trim();
  const nxt = next.trim();
  if (cur.toLowerCase() === nxt.toLowerCase()) return { blocked: null, stamp: false };
  if (!cur) return { blocked: null, stamp: false };
  if (premium) return { blocked: null, stamp: true };
  if (changedAt) {
    const nextFree = changedAt.getTime() + NAME_CHANGE_COOLDOWN_MS;
    if (Date.now() < nextFree) {
      const when = new Date(nextFree).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
      return {
        blocked: `You already changed your ${label} in the last 30 days — you can change it again on ${when}. Premium members can change their ${label} any time.`,
        stamp: false,
      };
    }
  }
  return { blocked: null, stamp: true };
}

async function storyHiddenKeysFor(ctx: Ctx, authorKey: string): Promise<Set<string>> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.storyHiddenFrom)
    .where(eq(schema.storyHiddenFrom.playerKey, authorKey));
  return new Set(rows.map((r) => r.hiddenKey));
}

// Vice Credits cannot be bought. Premium (below) is the ONLY thing
// that can ever be paid for in ViceSunshine — there are no credit packs,
// no paid customisation and no paid effects. Credits are earned only
// from in-app activity, level milestones, community events, seasonal awards
// and the Premium weekly grant.
const PREMIUM_PRICE_CAD = "CA$4.99";

const newsItem = z.object({
  id: z.number(),
  title: z.string(),
  summary: z.string(),
  category: z.string(),
  sourceName: z.string(),
  sourceUrl: z.string(),
  publishedAt: z.string(),
});
const patchItem = z.object({
  id: z.number(),
  version: z.string(),
  releaseDate: z.string(),
  sizePs5: z.string(),
  sizeXbox: z.string(),
  notes: z.string(),
  sourceUrl: z.string(),
  // When the tracker recorded this update (real server timestamp),
  // so the Home Latest Update card and its detail view can show the
  // real time the update landed here.
  createdAt: z.string(),
});
const bugItem = z.object({
  id: z.number(),
  title: z.string(),
  platform: z.string(),
  description: z.string(),
  status: z.string(),
  fixedIn: z.string(),
  workaround: z.string(),
  votes: z.number(),
  votedByMe: z.boolean(),
  reporter: z.string(),
  reports: z.number(),
  flagged: z.boolean(),
  // Provenance: auto = found automatically online (Rockstar / GTA
  // sources, news, creators); sourceName / sourceUrl point at the
  // original report. Community reports have auto = false and empty
  // source fields.
  sourceName: z.string(),
  sourceUrl: z.string(),
  auto: z.boolean(),
  createdAt: z.string(),
});
const eggItem = z.object({
  id: z.number(),
  name: z.string(),
  location: z.string(),
  howTo: z.string(),
  status: z.string(),
  x: z.number(),
  y: z.number(),
  sourceName: z.string(),
  sourceUrl: z.string(),
});
const pinItem = z.object({
  id: z.number(),
  name: z.string(),
  layer: z.string(),
  detail: z.string(),
  x: z.number(),
  y: z.number(),
});
const guideItem = z.object({
  id: z.number(),
  title: z.string(),
  category: z.string(),
  body: z.string(),
  author: z.string(),
  createdAt: z.string(),
});
const codeHowTosResponse = z.object({
  items: z.array(
    z.object({
      codeName: z.string(),
      links: z.array(
        z.object({
          kind: z.enum(["video", "guide", "article"]),
          title: z.string(),
          url: z.string(),
          sourceName: z.string(),
          guideId: z.number(),
          guideCategory: z.string(),
        }),
      ),
    }),
  ),
});
const clanSummary = z.object({
  id: z.number(),
  name: z.string(),
  tag: z.string(),
  color: z.string(),
  motto: z.string(),
  description: z.string(),
  rules: z.string(),
  platform: z.string(),
  region: z.string(),
  language: z.string(),
  playstyle: z.string(),
  privacy: z.string(),
  maxMembers: z.number(),
  memberCount: z.number(),
  eventsHeld: z.number(),
  wins: z.number(),
  faction: z.string(),
  factionPoints: z.number(),
  emblem: z.string(),
  emblemEffect: z.string(),
  trophies: z.number(),
  xp: z.number(),
  level: z.number(),
  league: z.string(),
  walletCredits: z.number(),
  bannerStyle: z.string(),
  callingCard: z.string(),
  nameColor: z.string(),
  rankPoints: z.number(),
  seasonPoints: z.number(),
  effectiveSeasonPoints: z.number(),
  effectiveLifetimePoints: z.number(),
  multiplier: z.number(),
  avgMemberLevel: z.number(),
  rankLevel: z.number(),
  rankNextLevelPoints: z.number(),
  rankPointsToNext: z.number(),
  warsWon: z.number(),
  seasonRank: z.number(),
});
const clanBoardGraph = z.object({
  labels: z.array(z.string()),
  crews: z.array(z.object({
    id: z.number(),
    name: z.string(),
    color: z.string(),
    values: z.array(z.number()),
  })),
});
// Avatar artwork: original ViceSunshine character illustrations generated
// server-side and stored as owned blobs; meta rows map avatar id -> blob key.
async function avatarArtUrls(ctx: Ctx): Promise<Map<string, string>> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.meta);
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.key.startsWith("avatar-art:") && r.value) {
      try { map.set(r.key.slice("avatar-art:".length), await ctx.blobs.getUrl(r.value)); } catch { /* missing blob */ }
    }
  }
  return map;
}

// A profile's display avatar URL: the player's OWN uploaded picture
// (customAvatarBlobKey, moderation-checked before it was stored)
// wins; otherwise the equipped catalogue avatar's artwork.
async function profileAvatarUrl(
  ctx: Ctx,
  art: Map<string, string>,
  p: { avatarId: string; customAvatarBlobKey?: string },
): Promise<string> {
  if (p.customAvatarBlobKey) {
    try { return await ctx.blobs.getUrl(p.customAvatarBlobKey); } catch { /* missing blob — fall through */ }
  }
  return art.get(p.avatarId) ?? "";
}

// Bulk version for list views: playerKey -> custom picture URL for
// every profile that has one, so sync .map() rows can resolve a
// custom picture the same way they resolve catalogue artwork.
async function customAvatarUrls(ctx: Ctx): Promise<Map<string, string>> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.profiles);
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.customAvatarBlobKey) {
      try { map.set(r.playerKey, await ctx.blobs.getUrl(r.customAvatarBlobKey)); } catch { /* missing blob */ }
    }
  }
  return map;
}
// The player's OWN uploaded banner media (a picture or a short
// video), resolved to a renderable URL — "" when they have none,
// in which case their calling card is the banner.
async function profileBannerUrl(ctx: Ctx, p: { bannerBlobKey: string }): Promise<string> {
  if (!p.bannerBlobKey) return "";
  try { return await ctx.blobs.getUrl(p.bannerBlobKey); } catch { return ""; }
}

function pickAvatar(
  art: Map<string, string>,
  custom: Map<string, string>,
  prof: { playerKey: string; avatarId: string } | undefined,
): string {
  if (!prof) return "";
  return custom.get(prof.playerKey) ?? art.get(prof.avatarId) ?? "";
}

// Automatic image moderation for uploads that will be shown
// publicly (Feed media and custom avatar pictures): JPEG / PNG are
// checked by the moderation model BEFORE anything is stored —
// nudity or sexual content, anything sexualising a minor, graphic
// real-world gore, real-world illegal trade and scam / leak /
// piracy adverts are rejected and never stored. Other formats
// cannot be read by the checker and are rejected outright for
// avatar pictures (see uploadCustomAvatar), so no avatar picture
// can bypass the check.
async function assertImageAllowed(
  ctx: Ctx,
  dataBase64: string,
  mimeType: string,
  filename: string,
  what: string,
): Promise<void> {
  if (mimeType !== "image/jpeg" && mimeType !== "image/png") return;
  const verdict = await ctx.inference.complete(
    "You are the automatic content moderator for a gaming community app. Decide whether this uploaded image may be shown publicly. Reject it (allowed=false) if it contains: nudity or sexual content of any kind; anything sexualising a minor; graphic real-world gore or violence; real-world illegal drugs or weapons being sold; or text advertising scams, leaked content or pirated downloads. Game screenshots and game artwork, cars, characters in normal clothing, non-sexual memes, portraits and landscapes are allowed. Give a short plain reason when rejecting.",
    {
      schema: z.object({ allowed: z.boolean(), reason: z.string() }),
      images: [{ dataBase64, mimeType, filename }],
    },
  );
  if (!verdict.allowed) {
    throw new Error(
      `Blocked by automatic moderation: this ${what} can't be used — ${verdict.reason || "it breaks the community rules"}. Nude and illegal pictures are never allowed. If you think this is a mistake, ask Vice to open a support request for a human review.`,
    );
  }
}

const cosmeticItemView = z.object({
  // Challenge calling cards only: the challenge text, the player's
  // progress toward it, and whether it is still locked. Empty / false
  // for every normal catalogue item.
  challenge: z.string(),
  progress: z.string(),
  locked: z.boolean(),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  scope: z.string(),
  kind: z.string(),
  value: z.string(),
  ownedByMe: z.boolean(),
  equippedByMe: z.boolean(),
  ownedByClan: z.boolean(),
  equippedByClan: z.boolean(),
  premiumOnly: z.boolean(),
  imageUrl: z.string(),
});
const memberItem = z.object({
  id: z.number(),
  playerKey: z.string(),
  gamertag: z.string(),
  platform: z.string(),
  role: z.string(),
  squad: z.string(),
  isMe: z.boolean(),
  joinedAt: z.string(),
  nameColor: z.string(),
  avatarFrame: z.string(),
  avatarUrl: z.string(),
  badge: z.string(),
  inVoice: z.boolean(),
  presence: z.string(),
  links: linksShape,
});
const eventItem = z.object({
  id: z.number(),
  title: z.string(),
  type: z.string(),
  startsAt: z.string(),
  timezone: z.string(),
  platform: z.string(),
  maxPlayers: z.number(),
  description: z.string(),
  rules: z.string(),
  prize: z.string(),
  host: z.string(),
  results: z.string(),
  lobbyDetails: z.string(),
  lobbyLink: z.string(),
  earlyAccess: z.boolean(),
  earlyAccessUntil: z.string(),
  canRsvpGoing: z.boolean(),
  isExample: z.boolean(),
  going: z.number(),
  maybe: z.number(),
  myRsvp: z.string(),
  visibility: z.string(),
  hashtags: z.array(z.string()),
  hostClanId: z.number(),
  hostClanName: z.string(),
  spotsLeft: z.number(),
  // The private event's invite code — only filled for the host and
  // the host clan's members (the people who share it), or for a
  // player who just looked the event up BY that code. "" otherwise.
  inviteCode: z.string(),
  // True when the viewer is the Leader of the hosting clan — the
  // only person who can edit this event, switch it Public / Private,
  // post its results or remove it (enforced again in updateEvent /
  // deleteEvent / setEventResults / hostConfirmEvent).
  canManage: z.boolean(),
  // The leader-uploaded event picture, resolved to a URL ("" when
  // the leader has not uploaded one — the card shows the standard
  // events artwork instead).
  imageUrl: z.string(),
  // True when the host has removed this viewer from the event —
  // they cannot RSVP again (enforced in rsvpEvent).
  kicked: z.boolean(),
});

// Who controls a Community Event: the Leader of the hosting clan.
// (Legacy clan-less rows fall back to the host gamertag.) Creating an
// event additionally requires the clan to have 10+ members — that
// gate is creation-only (see createEvent); a Leader keeps control of
// an existing event even if the clan later dips below 10.
async function isEventManager(
  ctx: Ctx,
  ev: { clanId: number | null; host: string },
  playerKey: string,
  gamertag: string,
): Promise<boolean> {
  if (ev.clanId) {
    const me = await myMembership(ctx, ev.clanId, playerKey);
    return me?.role === "Leader";
  }
  return gamertag !== "" && ev.host.toLowerCase() === gamertag.toLowerCase();
}

// ---- Community Events hashtags ----
// Players find events by name OR by hashtag. Hashtags are stored
// normalised (lowercase, no "#", space-separated) and every event
// also carries automatic tags derived from its type, so a Car Meet
// is always findable as #carmeet even if the host typed no tags.
const EVENT_TYPE_HASHTAGS: Record<string, string[]> = {
  "Car Meet": ["carmeet", "meetup", "cars"],
  "Race / Street Race": ["race", "streetrace", "racing"],
  "Street Racing": ["race", "streetrace", "racing"],
  "Off-Road / Mud Club Racing": ["offroad", "race", "mudclub"],
  "Time Trial": ["timetrial", "timeattack", "race"],
  "Screenshot Contest": ["screenshot", "contest", "photo"],
  "Crew Event": ["clan", "clanmeet", "crew"],
  "Easter Egg Hunt": ["easteregg", "hunt", "secrets"],
  "Watch Party": ["watchparty", "trailer"],
  "Cruise / Convoy": ["cruise", "convoy", "carmeet"],
  "Fashion / Outfit Contest": ["fashion", "contest", "outfit"],
};
function normalizeHashtags(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const tag = part.replace(/^#+/, "").toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 8);
}
function hashtagsForEvent(type: string, stored: string): string[] {
  const auto = EVENT_TYPE_HASHTAGS[type] ?? [type.toLowerCase().replace(/[^a-z0-9]+/g, "")].filter(Boolean);
  const out: string[] = [];
  for (const t of [...normalizeHashtags(stored), ...auto]) {
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 8);
}
// Legacy rows can still carry the old pre-rename event types
// ("Clan War" / "Clan Event") — they are presented as Crew Events.
function displayEventType(type: string): string {
  return type === "Clan War" || type === "Clan Event" || type === "Crew War" ? "Crew Event" : type;
}
// Private-event invite codes: short, unambiguous (no 0/O/1/I/L), so a
// player can read one out or type it without mistakes.
const INVITE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newInviteCode(): string {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += INVITE_CODE_ALPHABET[Math.floor(Math.random() * INVITE_CODE_ALPHABET.length)];
  }
  return out;
}
function normalizeInviteCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

type ProfileRow = typeof schema.profiles.$inferSelect;
function visibleLinks(r: ProfileRow | undefined, opts?: { isSelf?: boolean; sameCrew?: boolean }): z.infer<typeof linksShape> {
  if (!r) return { psn: "", xbox: "", discord: "", rockstar: "", others: [] };
  let others: { label: string; url: string }[] = [];
  if (r.showOther === 1 && r.otherLinks) {
    try {
      const parsed = JSON.parse(r.otherLinks) as { label?: string; url?: string }[];
      if (Array.isArray(parsed)) {
        others = parsed
          .filter((o) => o.label && o.url)
          .map((o) => ({ label: String(o.label), url: String(o.url) }));
      }
    } catch {
      others = [];
    }
  }
  return {
    psn: r.showPsn === 1 ? r.psnId : "",
    xbox: r.showXbox === 1 ? r.xboxId : "",
    discord: r.showDiscord === 1 ? r.discordId : "",
    // Rockstar ID visibility (owner's direction): Public (showRockstar
    // 1) = everyone can see and copy it. Private (the default) = only
    // the player and their crew — callers pass isSelf / sameCrew where
    // they know the relationship; everywhere else it stays hidden.
    rockstar: r.showRockstar === 1 || opts?.isSelf || opts?.sameCrew ? r.rockstarId : "",
    others,
  };
}
async function profilesByKey(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.profiles);
  return new Map(rows.map((r) => [r.playerKey, r]));
}

async function getMeta(ctx: Ctx, key: string): Promise<string> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.meta).where(eq(schema.meta.key, key));
  return rows[0]?.value ?? "";
}
async function setMeta(ctx: Ctx, key: string, value: string) {
  const db = ctx.db<typeof schema>();
  await db
    .insert(schema.meta)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.meta.key, set: { value } });
}

async function myMembership(ctx: Ctx, clanId: number, playerKey: string) {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.clanMembers)
    .where(
      and(
        eq(schema.clanMembers.clanId, clanId),
        eq(schema.clanMembers.playerKey, playerKey),
      ),
    );
  return rows[0] ?? null;
}

// ---- Community Event weekly limit ----
// One community event per crew Leader per week (owner's direction),
// IN ADDITION to the Leader + 10-member rules — it never replaces
// them. Counted per PERSON across every crew they lead, from the
// events' real created_at stamps: the next event unlocks exactly 7
// days after the most recent one they created.
const EVENT_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
async function leaderWeeklyEventState(
  ctx: Ctx,
  playerKey: string,
): Promise<{ isLeader: boolean; lastTitle: string; lastAtMs: number; nextAtMs: number }> {
  const db = ctx.db<typeof schema>();
  const led = await db
    .select()
    .from(schema.clanMembers)
    .where(and(eq(schema.clanMembers.playerKey, playerKey), eq(schema.clanMembers.role, "Leader")));
  if (led.length === 0) return { isLeader: false, lastTitle: "", lastAtMs: 0, nextAtMs: 0 };
  const ledIds = new Set(led.map((m) => m.clanId));
  const mine = (await db.select().from(schema.events)).filter(
    (e) => e.clanId !== null && ledIds.has(e.clanId) && e.createdAt,
  );
  let lastTitle = "";
  let lastAtMs = 0;
  for (const e of mine) {
    const t = e.createdAt ? e.createdAt.getTime() : 0;
    if (t > lastAtMs) {
      lastAtMs = t;
      lastTitle = e.title;
    }
  }
  return { isLeader: true, lastTitle, lastAtMs, nextAtMs: lastAtMs > 0 ? lastAtMs + EVENT_WEEK_MS : 0 };
}

// ---- Clan channel helpers ----
// ViceSunshine has no in-app voice chat: voice chat, hangouts and lobby
// meetups happen on the community Discord server (see the Discord
// invite actions). Clan channels here are text channels only.
// The channels every clan starts with. They are materialised as real
// clan_channels rows the first time anyone reads them, so Leaders can
// rename / reorder / delete them like any other channel afterwards.
const DEFAULT_CLAN_CHANNELS: {
  kind: "text" | "voice";
  key: string;
  name: string;
  sortOrder: number;
}[] = [
  { kind: "text", key: "announcement", name: "announcements", sortOrder: 0 },
  { kind: "text", key: "feed", name: "crew-feed", sortOrder: 1 },
  { kind: "text", key: "chat", name: "chat", sortOrder: 2 },
];

type ClanChannelRow = typeof schema.clanChannels.$inferSelect;

// Returns the clan's channels (defaults materialised on first read),
// sorted for display: text channels in order.
async function clanChannelsOf(ctx: Ctx, clanId: number): Promise<ClanChannelRow[]> {
  const db = ctx.db<typeof schema>();
  let rows = await db
    .select()
    .from(schema.clanChannels)
    .where(eq(schema.clanChannels.clanId, clanId));
  if (rows.length === 0) {
    for (const d of DEFAULT_CLAN_CHANNELS) {
      await db.insert(schema.clanChannels).values({
        clanId,
        kind: d.kind,
        key: d.key,
        name: d.name,
        visibility: "public",
        allowedRoles: "",
        allowedKeys: "",
        memberLimit: 0,
        sortOrder: d.sortOrder,
      });
    }
    rows = await db
      .select()
      .from(schema.clanChannels)
      .where(eq(schema.clanChannels.clanId, clanId));
  }
  return rows.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "text" ? -1 : 1) ||
      a.sortOrder - b.sortOrder ||
      a.id - b.id,
  );
}

// Who may structure a clan's channels: the Leader and Co-Leaders
// always; Elders only when the Leader switched that on for the clan.
function canManageChannels(role: string, clan: typeof schema.clans.$inferSelect): boolean {
  if (role === "Leader" || role === "Co-Leader") return true;
  return role === "Elder" && clan.eldersManageChannels === 1;
}

// Private channels are invisible — not just locked — to anyone not on
// the allow-list. Leader / Co-Leader always see every channel.
function channelVisibleTo(
  ch: ClanChannelRow,
  role: string,
  playerKey: string,
): boolean {
  if (ch.visibility !== "private") return true;
  if (role === "Leader" || role === "Co-Leader") return true;
  const roles = ch.allowedRoles.split(",").map((s) => s.trim()).filter(Boolean);
  if (role && roles.includes(role)) return true;
  const keys = ch.allowedKeys.split(",").map((s) => s.trim()).filter(Boolean);
  return keys.includes(playerKey);
}
async function logActivity(
  ctx: Ctx,
  clanId: number,
  actor: string,
  action: string,
  target: string,
  reason: string,
) {
  const db = ctx.db<typeof schema>();
  await db.insert(schema.clanActivity).values({ clanId, actor, action, target, reason });
}

async function logCredit(
  ctx: Ctx,
  scope: "personal" | "clan",
  ownerId: string,
  actorKey: string,
  amount: number,
  reason: string,
) {
  const db = ctx.db<typeof schema>();
  await db.insert(schema.creditTransactions).values({ scope, ownerId, actorKey, amount, reason });
}

async function creditPersonalWallet(
  ctx: Ctx,
  playerKey: string,
  amount: number,
  reason: string,
) {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.profiles)
    .where(eq(schema.profiles.playerKey, playerKey));
  const prof = rows[0];
  if (!prof) return; // No profile yet — points are still recorded; credits land once they have a wallet.
  await db
    .update(schema.profiles)
    .set({ credits: prof.credits + amount })
    .where(eq(schema.profiles.id, prof.id));
  await logCredit(ctx, "personal", playerKey, playerKey, amount, reason);
}

// Personal confirmed points for a player, deduped by sourceRef (the same
// activity may be recorded once per clan the player belongs to).
function personalPointsOf(
  events: (typeof schema.rankPointEvents.$inferSelect)[],
  playerKey: string,
): number {
  const seen = new Map<string, number>();
  for (const e of events) {
    if (e.playerKey !== playerKey) continue;
    if (!seen.has(e.sourceRef)) seen.set(e.sourceRef, e.points);
  }
  return [...seen.values()].reduce((s, p) => s + p, 0);
}

// Computes per-clan rank stats for a given season from CONFIRMED point
// events only (Pending claims never count). The member-level multiplier:
// a clan's points are multiplied by its average member level tier, so
// higher-level members lift the whole clan.
async function computeClanRankStats(
  ctx: Ctx,
  seasonKey: string,
): Promise<Map<number, ClanRankStats>> {
  const db = ctx.db<typeof schema>();
  const events = await db.select().from(schema.rankPointEvents);
  const members = await db.select().from(schema.clanMembers);
  const clans = await db.select().from(schema.clans);
  const personalByKey = new Map<string, number>();
  for (const m of members) {
    if (!personalByKey.has(m.playerKey)) {
      personalByKey.set(m.playerKey, personalPointsOf(events, m.playerKey));
    }
  }
  const out = new Map<number, ClanRankStats>();
  for (const clan of clans) {
    const clanEvents = events.filter((e) => e.clanId === clan.id);
    const rawLifetime = clanEvents.reduce((s, e) => s + e.points, 0);
    const rawSeason = clanEvents
      .filter((e) => e.seasonKey === seasonKey)
      .reduce((s, e) => s + e.points, 0);
    const clanMembers = members.filter((m) => m.clanId === clan.id);
    let multiplier = 1;
    let avgLevel = 1;
    if (clanMembers.length > 0) {
      const levels = clanMembers.map(
        (m) => playerLevelFromPoints(personalByKey.get(m.playerKey) ?? 0).level,
      );
      avgLevel = levels.reduce((s, l) => s + l, 0) / levels.length;
      const avgTier =
        levels.reduce((s, l) => s + playerTierOf(l), 0) / levels.length;
      multiplier = Math.min(2, 1 + (avgTier - 1) * 0.25);
    }
    const effLifetime = Math.round(rawLifetime * multiplier);
    const effSeason = Math.round(rawSeason * multiplier);
    const lvl = clanRankLevelFromPoints(effLifetime);
    out.set(clan.id, {
      rankPoints: rawLifetime,
      seasonPoints: rawSeason,
      effectiveSeasonPoints: effSeason,
      effectiveLifetimePoints: effLifetime,
      multiplier: Math.round(multiplier * 100) / 100,
      avgMemberLevel: Math.round(avgLevel * 10) / 10,
      rankLevel: lvl.level,
      rankNextLevelPoints: lvl.nextAt,
      rankPointsToNext: Math.max(0, lvl.nextAt - effLifetime),
    });
  }
  return out;
}

// ---- Feed media helpers ----
const FEED_KIND_TABS: Record<string, string[]> = {
  Clips: ["Clip"],
  Funny: ["Funny"],
  Memes: ["Meme"],
  "Streamer Clips": ["Streamer Clip"],
  Tutorials: ["Tutorial"],
  Gameplay: ["Gameplay"],
  "Car Meet": ["Car Meet"],
  News: ["News", "News Discussion"],
  Discussion: ["Discussion", "Post", "Question", "Screenshot", "Easter Egg Find"],
};
const FEED_EXAMPLE_KEY = "viceverse-examples";
const FEED_AUTO_KEY = "viceverse-auto";

// Search snippets arrive with crawler boilerplate ("Last Updated: …
// ago Last Crawl: … ago") and video titles often carry emoji, which
// ViceSunshine never shows. Strip both before storing found content.
function cleanFoundText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^Last Updated:\s*.{0,48}?ago\s*/i, "")
    .replace(/^Last Crawl:\s*.{0,48}?ago\s*/i, "");
}
function stripEmoji(text: string): string {
  return text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
function youtubeIdOf(url: string): string {
  const m = url.match(
    /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,20})/,
  );
  return m?.[1] ?? "";
}

// ---- Easter egg detail helpers ----
// One web search, parsed the same way refreshNews / refreshFeedMedia
// parse the server search tool (results nested under
// content.results, text in "snippet"). Returns [] on any failure —
// a failed search simply means nothing new is added this run.
async function webSearchResults(
  ctx: Ctx,
  query: string,
): Promise<{ title: string; url: string; content: string }[]> {
  try {
    const raw = (await ctx.tool.web_search(query)) as unknown;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const container = parsed as {
      content?: { results?: Record<string, unknown>[] };
      results?: Record<string, unknown>[];
    };
    const list =
      container?.content?.results ??
      container?.results ??
      (Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []);
    return list.map((r) => ({
      title: typeof r.title === "string" ? r.title : "",
      url: typeof r.url === "string" ? r.url : "",
      content:
        typeof r.content === "string"
          ? r.content
          : typeof r.snippet === "string"
            ? r.snippet
            : "",
    }));
  } catch {
    return [];
  }
}

// Distinctive words from an egg's name, used to match related Feed
// posts and guides: short words and generic GTA filler are dropped,
// so "Vercetti Estate references" matches on vercetti / estate.
const EGG_STOPWORDS = new Set([
  "gta", "vi", "the", "a", "an", "of", "in", "on", "at", "to", "and",
  "return", "returns", "reference", "references", "easter", "egg",
  "secret", "hidden", "find", "found",
]);
function eggKeywords(name: string): string[] {
  return [
    ...new Set(
      name
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !EGG_STOPWORDS.has(w)),
    ),
  ];
}
// A text is about this egg when it names it in full, or mentions at
// least two of its distinctive words (one is enough when the name
// has only one distinctive word to give).
function textMatchesEgg(text: string, name: string, keywords: string[]): boolean {
  const t = text.toLowerCase();
  if (name.trim().length >= 4 && t.includes(name.trim().toLowerCase())) return true;
  const hits = keywords.filter((k) => t.includes(k)).length;
  return hits >= Math.min(2, Math.max(1, keywords.length));
}
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Web";
  }
}
// Uploaded media lives behind blob URLs (./blobs/<token>) whose
// visible form carries no file extension: the token is the
// base64url of the blob key, and the key ends with the original
// filename (feed/<player>/<timestamp>-photo.png). Decode it (best
// effort — any failure just falls back to the plain URL checks)
// so an uploaded picture or clip is recognised as what it is.
function blobKeyOf(url: string): string {
  const m = /\/blobs\/([A-Za-z0-9_-]+={0,2})/.exec(url);
  const token = m?.[1];
  if (!token) return "";
  try {
    return Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function feedMediaOf(url: string): { mediaType: string; embedUrl: string; videoId: string } {
  if (!url) return { mediaType: "none", embedUrl: "", videoId: "" };
  // Blob uploads first: without this, every uploaded picture was
  // misread as a plain link and every uploaded story photo as an
  // embed — the upload "worked" but the picture never rendered.
  const blobKey = blobKeyOf(url);
  if (blobKey) {
    if (/\.(mp4|webm)\b/i.test(blobKey)) return { mediaType: "video", embedUrl: "", videoId: "" };
    if (/\.(png|jpe?g|webp|gif)\b/i.test(blobKey)) return { mediaType: "image", embedUrl: "", videoId: "" };
  }
  const yt = youtubeIdOf(url);
  // Standard youtube.com embed endpoint: the youtube-nocookie host
  // stalled on a black screen in the app webview (it waits on a cookie
  // consent flow the embedded view never completes). The client player
  // still retries the nocookie host as its alternate if this one is
  // blocked, and always keeps a Watch on YouTube link under the player.
  if (yt) return { mediaType: "youtube", embedUrl: `https://www.youtube.com/embed/${yt}`, videoId: yt };
  if (/\.(mp4|webm)\b/i.test(url)) return { mediaType: "video", embedUrl: "", videoId: "" };
  if (/\.(png|jpe?g|webp|gif)\b/i.test(url)) return { mediaType: "image", embedUrl: "", videoId: "" };
  if (/vimeo\.com\/\d+/i.test(url)) return { mediaType: "link", embedUrl: "", videoId: "" };
  return { mediaType: "link", embedUrl: "", videoId: "" };
}

// A story's stored media type can predate the blob recognition
// above (an uploaded photo stored as "embed"); at read time the
// URL's real type wins whenever it resolves to a picture or clip,
// so older uploaded stories render correctly too.
function storyMediaTypeOf(storedType: string, mediaUrl: string): string {
  const m = feedMediaOf(mediaUrl);
  return m.mediaType === "image" || m.mediaType === "video" ? m.mediaType : storedType;
}

// Best-effort embeddability check for a found video, via YouTube's
// oEmbed endpoint: it answers 404 for videos that are gone and 401
// for videos whose owner disabled embedding — exactly the rows that
// used to land in the Feed as dead black players. A network failure
// proves nothing, so it accepts the video (the client player still
// falls back to a thumbnail + Watch on YouTube link if a video
// cannot actually play in a given view).
async function youtubeEmbeddable(videoId: string): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
      { signal: ctl.signal },
    );
    clearTimeout(timer);
    return res.ok;
  } catch {
    return true;
  }
}

// Editorial news picture for an Automatic News post: fetch the
// article's own og:image (or twitter:image), store the bytes as an
// owned blob, and return its key. Ben approved real pictures to
// illustrate specific news stories in the Feed (Nov 19, 2026),
// credited to the source with the full story linked — editorial use
// only; Database / Customise / Profile art stays original. Any
// failure (no image declared, wrong type, too big, network) simply
// means the post carries no picture — it never blocks the post.
async function fetchEditorialImage(ctx: Ctx, pageUrl: string): Promise<string> {
  try {
    const get = async (u: string) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      try {
        return await fetch(u, { signal: ctl.signal, headers: { "user-agent": "ViceSunshine/1.0 (fan community news reader)" } });
      } finally {
        clearTimeout(timer);
      }
    };
    const page = await get(pageUrl);
    if (!page.ok) return "";
    const html = (await page.text()).slice(0, 300000);
    const m =
      html.match(/<meta[^>]+property=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["'](?:og:image|twitter:image)["']/i) ??
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    const raw = m?.[1]?.trim() ?? "";
    if (!raw) return "";
    let imgUrl = "";
    try {
      imgUrl = new URL(raw, pageUrl).toString();
    } catch {
      return "";
    }
    const img = await get(imgUrl);
    if (!img.ok) return "";
    const ct = (img.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(ct)) return "";
    const bytes = new Uint8Array(await img.arrayBuffer());
    if (bytes.length < 2000 || bytes.length > 6_000_000) return "";
    const key = `feed-news/${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
    await ctx.blobs.put(key, bytes, { contentType: ct });
    return key;
  } catch {
    return "";
  }
}

// Definitive dead-video check for the re-verification sweep: only a
// real oEmbed 404 (gone) or 401 (private / embedding disabled) counts
// as dead. A network failure proves nothing and keeps the video.
async function youtubeDefinitivelyDead(videoId: string): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
      { signal: ctl.signal },
    );
    clearTimeout(timer);
    return res.status === 404 || res.status === 401;
  } catch {
    return false;
  }
}

// ---- TikTok clips (the Clips section's source) ----
// The owner moved Clips off YouTube (its embeds kept failing in the
// app webview) and onto TikTok. A TikTok video id / creator handle
// come from the canonical permalink https://www.tiktok.com/@<handle>/video/<id>.
// Playback uses TikTok's official player endpoint — the exact iframe
// src TikTok's own oEmbed endpoint returns for a permalink:
// https://www.tiktok.com/player/v1/<id>?...&autoplay=1&muted=1
// (verified live at build time: oEmbed answered 200 with that player
// URL for every curated clip below). Nothing is downloaded or
// re-uploaded; the clip plays from TikTok, credited to its creator,
// with a link back to the original TikTok.
function tiktokIdOf(url: string): string {
  const m = (url ?? "").match(/tiktok\.com\/(?:@[^/]+\/video\/|player\/v1\/|embed\/v2?\/)(\d{6,25})/);
  return m?.[1] ?? "";
}
function tiktokHandleOf(url: string): string {
  const m = (url ?? "").match(/tiktok\.com\/@([^/]+)\/video\//);
  return m?.[1] ?? "";
}
function tiktokPermalink(handle: string, videoId: string): string {
  return `https://www.tiktok.com/@${handle}/video/${videoId}`;
}
// Playability check via TikTok's oEmbed endpoint: 200 means the video
// exists and its owner allows embedding — the only clips allowed in
// Clips. A network failure proves nothing, so it accepts the clip
// (the client player still falls back to a credited link card, never
// a black box, if a frame cannot load in a given view).
async function tiktokEmbeddable(permalink: string): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(permalink)}`,
      { signal: ctl.signal },
    );
    clearTimeout(timer);
    return res.ok;
  } catch {
    return true;
  }
}
// Definitive dead check (for pruning automatic rows): only a real
// oEmbed error status counts; a network failure keeps the clip.
async function tiktokDefinitivelyDead(permalink: string): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(permalink)}`,
      { signal: ctl.signal },
    );
    clearTimeout(timer);
    return res.status === 400 || res.status === 403 || res.status === 404;
  } catch {
    return false;
  }
}
// Curated GTA VI TikTok clips: real permalinks found by web search
// (see DATA-PLAN "TikTok clips"), each validated through TikTok
// oEmbed before it is ever stored. Captions are the creators' own
// post titles, shortened, with emoji stripped per the owner's rule.
const TIKTOK_CLIP_SEED: { handle: string; videoId: string; title: string }[] = [
  { handle: "hiper.ae", videoId: "7678864554830351636", title: "GTA VI trailer — extended look edit" },
  { handle: "cliip2gtavi", videoId: "7709121479690046753", title: "GTA VI clip" },
  { handle: "gta6creator1", videoId: "7697417842278321421", title: "GTA VI countdown — launch trailer news" },
  { handle: "dr_gta6", videoId: "7708423174878235926", title: "GTA VI clip" },
  { handle: "gta6intelroom", videoId: "7706347329326124321", title: "GTA 6 News — GTA VI clip" },
  { handle: "gtavi.clips5", videoId: "7702451645417868576", title: "GTA VI clip" },
  { handle: "tonysixoficial", videoId: "7617965414315773206", title: "GTA VI clip" },
];
const TIKTOK_AUTO_KEY = "viceverse-tiktok";
// Stores any missing curated TikTok clips (oEmbed-validated first).
// Returns how many were added. Existing rows are never edited.
async function ensureTikTokClips(ctx: Ctx): Promise<number> {
  const db = ctx.db<typeof schema>();
  const existing = await db.select().from(schema.feedPosts);
  const seen = new Set(existing.map((r) => tiktokIdOf(r.mediaUrl)).filter(Boolean));
  let added = 0;
  for (const c of TIKTOK_CLIP_SEED) {
    if (seen.has(c.videoId)) continue;
    const permalink = tiktokPermalink(c.handle, c.videoId);
    if (!(await tiktokEmbeddable(permalink))) continue;
    await db.insert(schema.feedPosts).values({
      authorKey: TIKTOK_AUTO_KEY,
      author: c.handle,
      kind: "Clip",
      title: c.title,
      body: `GTA VI clip from TikTok — credit to @${c.handle} on TikTok. It plays here from TikTok; watch the original at the source.`,
      mediaUrl: permalink,
      auto: 1,
      sourceName: "TikTok",
      sourceUrl: permalink,
    });
    seen.add(c.videoId);
    added += 1;
  }
  return added;
}

// A video post's own YouTube URL must never appear as text in the body
// — the video plays in the embedded player at the top of the card, and
// a raw link in the text reads as "go to YouTube to watch". Strip any
// YouTube URL (and the post's exact media URL) from the displayed body.
const YOUTUBE_URL_RE =
  /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?[^\s]+|shorts\/[^\s]+|embed\/[^\s]+|live\/[^\s]+)|youtu\.be\/[^\s]+)/gi;
function stripVideoUrlsFromBody(body: string, mediaUrl: string): string {
  let out = body.replace(YOUTUBE_URL_RE, "");
  if (mediaUrl) out = out.split(mediaUrl).join("");
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// ---- Premium weekly credits ----
// Premium ($4.99/month) includes 250 Vice Credits every week, granted
// automatically while the membership is active — 1,000 per month. The
// grant is evaluated lazily whenever the wallet/profile is read: weeks
// are anchored to when the current Premium period started, each due
// week pays one 250-credit transaction labelled "Premium weekly
// credits". If Premium lapses, the anchor is cleared, so renewing later
// never pays for lapsed weeks. Premium credits are cosmetics-only, like
// bought credits: they cannot buy Rank Points, Clan Level, seasonal
// rank, or wins.
const PREMIUM_WEEKLY_CREDITS = 250;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function addMonths(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  out.setMonth(out.getMonth() + months);
  return out;
}

// The end of the current paid month for a Premium period anchored at
// `since`: the first monthly anniversary of the anchor that is still
// in the future. Cancelling Premium ends it here — never immediately.
function premiumPeriodEnd(since: Date, now: Date): Date {
  let end = addMonths(since, 1);
  let guard = 0;
  while (end.getTime() <= now.getTime() && guard < 240) {
    end = addMonths(end, 1);
    guard++;
  }
  return end;
}

async function applyPremiumWeeklyCredits(
  ctx: Ctx,
  playerKey: string,
): Promise<{ active: boolean; nextPayoutAt: string; endsAt: string; nextBillingAt: string; sinceAt: string }> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.profiles)
    .where(eq(schema.profiles.playerKey, playerKey));
  const prof = rows[0];
  const none = { active: false, nextPayoutAt: "", endsAt: "", nextBillingAt: "", sinceAt: "" };
  if (!prof) return none;
  if (prof.premium !== 1) {
    if (prof.premiumSince || prof.premiumEndsAt) {
      await db
        .update(schema.profiles)
        .set({ premiumSince: null, premiumWeeksGranted: 0, premiumEndsAt: null })
        .where(eq(schema.profiles.id, prof.id));
    }
    return none;
  }
  const now = new Date();
  const endsAtDate = prof.premiumEndsAt ?? null;
  // A cancelled Premium lapses at the end of its paid month: flip it
  // off lazily here, clear the anchor, and grant nothing for any week
  // after the end — lapsed time is never paid retroactively.
  if (endsAtDate && now.getTime() > endsAtDate.getTime()) {
    await db
      .update(schema.profiles)
      .set({ premium: 0, premiumSince: null, premiumWeeksGranted: 0, premiumEndsAt: null })
      .where(eq(schema.profiles.id, prof.id));
    return none;
  }
  let since = prof.premiumSince;
  let granted = prof.premiumWeeksGranted;
  if (!since) {
    since = now;
    granted = 0;
    await db
      .update(schema.profiles)
      .set({ premiumSince: since, premiumWeeksGranted: 0 })
      .where(eq(schema.profiles.id, prof.id));
  }
  // Weekly grants are counted against the earlier of now and the
  // cancellation end, so a cancelling member keeps earning until the
  // paid month ends — and not one week beyond it.
  const grantHorizon = endsAtDate && endsAtDate.getTime() < now.getTime() ? endsAtDate : now;
  const due = Math.floor((grantHorizon.getTime() - since.getTime()) / WEEK_MS) + 1;
  if (due > granted) {
    const fresh = await db
      .select()
      .from(schema.profiles)
      .where(eq(schema.profiles.id, prof.id));
    let balance = fresh[0]?.credits ?? prof.credits;
    for (let i = granted; i < due; i++) {
      balance += PREMIUM_WEEKLY_CREDITS;
      await logCredit(ctx, "personal", playerKey, playerKey, PREMIUM_WEEKLY_CREDITS, "Premium weekly credits");
    }
    await db
      .update(schema.profiles)
      .set({ credits: balance, premiumWeeksGranted: due })
      .where(eq(schema.profiles.id, prof.id));
    granted = due;
  }
  const next = new Date(since.getTime() + granted * WEEK_MS);
  return {
    active: true,
    nextPayoutAt: endsAtDate && next.getTime() > endsAtDate.getTime() ? "" : next.toISOString().slice(0, 10),
    endsAt: endsAtDate ? endsAtDate.toISOString().slice(0, 10) : "",
    nextBillingAt: endsAtDate ? "" : premiumPeriodEnd(since, now).toISOString().slice(0, 10),
    sinceAt: since.toISOString().slice(0, 10),
  };
}

// ---- Premium benefit checks (server-verified) ----
// Every Premium benefit is decided HERE, from the player's stored
// Premium state (via applyPremiumWeeklyCredits, which also lapses a
// cancelled membership at the end of its paid month and pays due
// weekly credits). The client never gets to assert Premium: actions
// that used to take a `premium` flag from the caller now look it up.
async function premiumActiveFor(ctx: Ctx, playerKey: string): Promise<boolean> {
  if (!playerKey) return false;
  const state = await applyPremiumWeeklyCredits(ctx, playerKey);
  return state.active;
}

// ---- Presence (online status) ----
// The player CHOOSES a status in Settings (profiles.presence):
// Online, Away, Do Not Disturb, Ghost or Offline. What others see is
// derived here, never taken from the client: Ghost reads as Offline
// to everyone except the player themselves (they appear offline
// while actually online), a manual Offline reads as Offline, and
// anyone whose last activity in ViceSunshine is over 5 minutes old
// reads as Offline whatever they chose. last_seen is refreshed
// (throttled to once a minute) whenever the player's own profile or
// settings load — being in the app is what "online" means here.
const PRESENCE_STALE_MS = 5 * 60 * 1000;

// When this server process loaded the actions bundle — the honest
// start of the current uptime window for the Home page's Live
// Server Status block. A genuine server restart reloads the bundle
// and resets it; the value is computed live per request, never
// stored in the database or padded.
const SERVER_PROCESS_STARTED_AT = new Date().toISOString();

// Hoisted so the getServerStatus handler can be annotated against
// it and z.literal(true) survives (see the response-schema rule).
const serverStatusResponse = z.object({
  online: z.literal(true),
  serverNow: z.string(),
  serverStartedAt: z.string(),
  playersOnline: z.number(),
  playersTotal: z.number(),
  pipelines: z.object({
    news: z.string(),
    feed: z.string(),
    database: z.string(),
    moderation: z.string(),
  }),
});

// Rockstar's official service status page — the one Rockstar's own
// support articles link players to for GTA Online / Rockstar Games
// service availability. The Home status surfaces read the latest
// stored check of this page (see refreshRockstarStatus); the URL is
// also the "check it yourself" link shown next to the status.
const ROCKSTAR_STATUS_URL = "https://support.rockstargames.com/servicestatus";
const rockstarStatusResponse = z.object({
  checkedAt: z.string().nullable(),
  overall: z.string(),
  services: z.array(z.object({ name: z.string(), status: z.string() })),
  sourceUrl: z.string(),
});
const profileAnalyticsResponse = z.object({
  hasProfile: z.boolean(),
  gamertag: z.string(),
  totals: z.object({
    followers: z.number(),
    following: z.number(),
    posts: z.number(),
    likes: z.number(),
    views: z.number(),
    comments: z.number(),
    saves: z.number(),
    reposts: z.number(),
  }),
  // Cumulative totals at the end of each of the last 14 days (UTC),
  // oldest first — the growth graph plots these directly.
  days: z.array(z.object({
    day: z.string(),
    followers: z.number(),
    following: z.number(),
    posts: z.number(),
    likes: z.number(),
    views: z.number(),
    comments: z.number(),
    saves: z.number(),
    reposts: z.number(),
  })),
  // The long cumulative daily series behind the graph's range
  // picker (1 year / 2 years / 3 years / year to date / all time):
  // one row per UTC day from the day the account was created
  // through today, capped at 3 years — no dates before creation.
  // Followers / Following are signed
  // series (they drop on unfollows); the rest only ever grow.
  // Zero-filled when there is nothing yet, so every range shows a
  // flat baseline with correct dates.
  history: z.array(z.object({
    day: z.string(),
    followers: z.number(),
    following: z.number(),
    posts: z.number(),
    likes: z.number(),
    views: z.number(),
    comments: z.number(),
    saves: z.number(),
    reposts: z.number(),
  })),
  // Last 7 days vs the 7 days before, per metric. pct is null when
  // the previous period was 0 — no invented percentage.
  compare: z.array(z.object({
    metric: z.string(),
    current: z.number(),
    previous: z.number(),
    delta: z.number(),
    pct: z.number().nullable(),
  })),
  // Per-month counts for EVERY month from the history start through
  // the current month (UTC months, oldest first) — the Spend-insights
  // style monthly header, month dropdown and Categories tab read
  // these. Followers / Following months are NET change (can be
  // negative). Always present and zero-filled, even with no profile,
  // so the analytics display is on screen from the start.
  months: z.array(z.object({
    key: z.string(),
    label: z.string(),
    followers: z.number(),
    following: z.number(),
    posts: z.number(),
    likes: z.number(),
    views: z.number(),
    comments: z.number(),
    saves: z.number(),
    reposts: z.number(),
  })),
  // The most recent individual growth events (newest first) for the
  // Activity list. Labels are generic — no other player's name or
  // account detail is ever included.
  recent: z.array(z.object({
    metric: z.string(),
    label: z.string(),
    at: z.string(),
  })),
});

// The three UTC calendar months ending with the current one, oldest
// first — the windows the analytics months are counted over.
function analyticsMonthWindows(fromMs?: number): { key: string; label: string; startMs: number; endMs: number }[] {
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const now = new Date();
  const currentMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  // Every month from the given start (the player's history start)
  // through the current month, oldest first — the month dropdown
  // lists them all. Without a start, the current month and the two
  // before it.
  let firstStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1);
  if (fromMs !== undefined && Number.isFinite(fromMs)) {
    const f = new Date(fromMs);
    firstStart = Math.min(currentMonthStart, Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), 1));
  }
  const out: { key: string; label: string; startMs: number; endMs: number }[] = [];
  for (let startMs = firstStart, guard = 0; startMs <= currentMonthStart && guard < 60; guard++) {
    const start = new Date(startMs);
    const endMs = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
    out.push({
      key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
      label: `${names[start.getUTCMonth()]} ${start.getUTCFullYear()}`,
      startMs,
      endMs,
    });
    startMs = endMs;
  }
  return out;
}
function effectivePresence(
  p: { playerKey: string; presence: string; lastSeen: Date | null },
  viewerKey: string,
): string {
  const chosen = p.presence || "Online";
  if (viewerKey && p.playerKey === viewerKey) return chosen;
  if (chosen === "Ghost" || chosen === "Offline") return "Offline";
  const seen = p.lastSeen ? p.lastSeen.getTime() : 0;
  if (!seen || Date.now() - seen > PRESENCE_STALE_MS) return "Offline";
  return chosen;
}
async function touchPresence(ctx: Ctx, playerKey: string): Promise<void> {
  if (!playerKey) return;
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.profiles)
    .where(eq(schema.profiles.playerKey, playerKey));
  const p = rows[0];
  if (!p) return;
  const last = p.lastSeen ? p.lastSeen.getTime() : 0;
  if (Date.now() - last < 60_000) return;
  await db
    .update(schema.profiles)
    .set({ lastSeen: new Date() })
    .where(eq(schema.profiles.id, p.id));
}

// A clan's real member cap: 200 when the clan was founded by a Premium
// member (stored at creation), and a clan whose current Leader has
// Premium is upgraded to 200 here (persisted, so the card, the clan
// home and every join path agree). Free clans stay at their stored
// cap (50). Members are never removed if Premium lapses — the cap
// only gates NEW joins.
async function effectiveClanCap(
  ctx: Ctx,
  clan: typeof schema.clans.$inferSelect,
): Promise<number> {
  if (clan.maxMembers >= 200) return clan.maxMembers;
  const db = ctx.db<typeof schema>();
  const members = await db
    .select()
    .from(schema.clanMembers)
    .where(eq(schema.clanMembers.clanId, clan.id));
  const leader = members.find((m) => m.role === "Leader");
  if (leader && (await premiumActiveFor(ctx, leader.playerKey))) {
    await db
      .update(schema.clans)
      .set({ maxMembers: 200 })
      .where(eq(schema.clans.id, clan.id));
    return 200;
  }
  return clan.maxMembers;
}

// Early event access: for the first 48 hours after a community event
// is created, only Premium members can RSVP Going — everyone else can
// RSVP Maybe, and Going opens to all when the window ends. Enforced
// in rsvpEvent; listEvents only reports the window.
const EVENT_EARLY_ACCESS_MS = 48 * 60 * 60 * 1000;
function eventEarlyAccessUntil(createdAt: Date): Date {
  return new Date(createdAt.getTime() + EVENT_EARLY_ACCESS_MS);
}

// ---- ViceSunshine level milestone rewards ----
// Levelling up in ViceSunshine pays Vice Credits at set milestones. The
// level comes ONLY from Rank Points earned by actions that happen
// inside ViceSunshine itself and are counted automatically there
// (event RSVPs / attendance, event results,
// points, feed and clan posts, recruiting, LFG teams formed). Nothing
// is based on a player's in-game GTA VI level — self-reported or
// otherwise — and no reward ever asks a player to report one. This
// is a ViceSunshine community level, not an official Rockstar level.
// Each milestone pays ONCE per player,
// lazily on wallet/profile read (same pattern as Premium weekly
// credits), and is idempotent via the transaction log: a milestone
// whose "Level milestone" transaction already exists never re-pays.
const LEVEL_MILESTONES: { level: number; credits: number }[] = [
  { level: 5, credits: 100 },
  { level: 10, credits: 250 },
  { level: 15, credits: 400 },
  { level: 20, credits: 600 },
  { level: 25, credits: 800 },
  { level: 30, credits: 1000 },
  { level: 40, credits: 1500 },
  { level: 50, credits: 2500 },
];
async function applyLevelMilestoneCredits(
  ctx: Ctx,
  playerKey: string,
  level: number,
): Promise<void> {
  const due = LEVEL_MILESTONES.filter((m) => level >= m.level);
  if (due.length === 0) return;
  const db = ctx.db<typeof schema>();
  const txs = await db
    .select()
    .from(schema.creditTransactions)
    .where(eq(schema.creditTransactions.ownerId, playerKey));
  const paid = new Set(
    txs
      .filter((t) => t.scope === "personal" && t.reason.startsWith("Level milestone"))
      .map((t) => t.reason),
  );
  for (const m of due) {
    const reason = `Level milestone — reached ViceSunshine Level ${m.level}`;
    if (paid.has(reason)) continue;
    await creditPersonalWallet(ctx, playerKey, m.credits, reason);
  }
}

// ---- Automatic activity points ----
// Rank Points are counted AUTOMATICALLY from actions that happen inside
// ViceSunshine: RSVPing to an event, posting in a clan feed, forming or
// joining an LFG team, joining a clan
// (personal only), a moderator confirming a bug / egg in the trackers,
// an event host confirming results in one tap, or a feed post reaching
// 10 real in-app likes. No uploads, no claim forms, no Pending queue.
// Light anti-cheat only: one count per action per player (deduped by
// sourceRef), per-source daily caps, and a Report button — 3 reports on
// a point entry remove it.
const SOURCE_DAILY_CAPS: Record<string, number> = {
  clanpost: 10,
  lfg: 50,
  feed: 10,
  feedpost: 25, // 5 XP per Feed post, up to 5 posts a day
};
const CLAN_BONUS_CREDITS = 2; // clan XP boost: +2 bonus credits on clan activity
const CLAN_WELCOME_BONUS = 50;

async function dailySourcePoints(
  ctx: Ctx,
  playerKey: string,
  source: string,
): Promise<number> {
  const db = ctx.db<typeof schema>();
  const events = await db.select().from(schema.rankPointEvents);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const seen = new Map<string, number>();
  for (const e of events) {
    if (e.playerKey !== playerKey || e.source !== source) continue;
    if (e.createdAt < start) continue;
    if (!seen.has(e.sourceRef)) seen.set(e.sourceRef, e.points);
  }
  return [...seen.values()].reduce((s, x) => s + x, 0);
}

// Records Rank Points for an automatic in-app activity. Returns true if
// points were recorded (false when deduped or over the daily cap).
// targetClanId: a specific clan, null = every clan the player is in,
// -1 = personal only (no clan points). The player earns Vice Credits
// equal to the points, plus the +2 clan bonus when a clan benefits.
async function recordPoints(
  ctx: Ctx,
  args: {
    playerKey: string;
    gamertag: string;
    targetClanId: number | null;
    points: number;
    source: string;
    sourceRef: string;
    reason: string;
    verifiedBy: string;
  },
): Promise<boolean> {
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select()
    .from(schema.rankPointEvents)
    .where(eq(schema.rankPointEvents.sourceRef, args.sourceRef));
  if (existing.some((e) => e.playerKey === args.playerKey)) return false;
  const cap = SOURCE_DAILY_CAPS[args.source];
  if (cap !== undefined) {
    const today = await dailySourcePoints(ctx, args.playerKey, args.source);
    if (today + args.points > cap) return false;
  }
  let clanIds: number[] = [];
  if (args.targetClanId !== null && args.targetClanId > 0) {
    clanIds = [args.targetClanId];
  } else if (args.targetClanId === null) {
    const mems = await db
      .select()
      .from(schema.clanMembers)
      .where(eq(schema.clanMembers.playerKey, args.playerKey));
    clanIds = mems.map((m) => m.clanId);
  }
  const seasonKey = seasonKeyOf(new Date());
  const rowsToInsert = clanIds.length > 0 ? clanIds : [0];
  for (const clanId of rowsToInsert) {
    await db.insert(schema.rankPointEvents).values({
      clanId,
      playerKey: args.playerKey,
      gamertag: args.gamertag,
      points: args.points,
      source: args.source,
      sourceRef: args.sourceRef,
      reason: args.reason,
      seasonKey,
      verifiedBy: args.verifiedBy,
    });
  }
  const bonus = clanIds.length > 0 ? CLAN_BONUS_CREDITS : 0;
  await creditPersonalWallet(
    ctx,
    args.playerKey,
    args.points + bonus,
    bonus > 0
      ? `Vice Credits earned — ${args.reason} (includes +${CLAN_BONUS_CREDITS} crew XP boost)`
      : `Vice Credits earned — ${args.reason}`,
  );
  return true;
}

// The +50 Vice Credits welcome bonus for joining a clan — once per clan.
async function clanWelcomeBonus(ctx: Ctx, playerKey: string, clanName: string) {
  const db = ctx.db<typeof schema>();
  const reason = `Crew welcome bonus — joined ${clanName}`;
  const txs = await db
    .select()
    .from(schema.creditTransactions)
    .where(eq(schema.creditTransactions.ownerId, playerKey));
  if (txs.some((t) => t.scope === "personal" && t.reason === reason)) return;
  await creditPersonalWallet(ctx, playerKey, CLAN_WELCOME_BONUS, reason);
}

// Recruiting: joining a clan automatically earns that clan +15 Rank
// Points and the new member their +50 credit welcome bonus.
async function awardRecruit(
  ctx: Ctx,
  clanId: number,
  clanName: string,
  playerKey: string,
  gamertag: string,
) {
  await recordPoints(ctx, {
    playerKey,
    gamertag,
    targetClanId: clanId,
    points: POINT_RATES.recruit,
    source: "recruit",
    sourceRef: `recruit:${clanId}:${playerKey}`,
    reason: `${gamertag} joined ${clanName}`,
    verifiedBy: "ViceSunshine (member joined in-app)",
  });
  await clanWelcomeBonus(ctx, playerKey, clanName);
}

// Realism pass (v3, owner-confirmed): Database art must look as close
// to the game as an original illustration can — near-photoreal,
// game-render detail — while staying an original ViceSunshine
// illustration, never a copy of Rockstar artwork, a trailer still or
// a logo, so the Database stays legally safe.
// IDENTICAL-ITEM pass (v5, owner's Duke 556 example): the old style
// brief graded every ITEM in a "neon pink, purple and teal palette"
// and some per-entry specs described the wrong item entirely (the
// 556 was briefed as "a modern bullpup assault rifle" and painted as
// a neon sci-fi bullpup, when the real GTA VI Duke 556 is a plain
// matte-black M16-pattern rifle). The v5 brief therefore grades only
// the BACKGROUND — ViceSunshine's own backgrounds stay exactly as
// they were (dark moody studio backdrop / neon-lit streets / flat
// navy cut-out) — while the ITEM ITSELF must be drawn identical to
// the real GTA VI item: same shape, proportions, factory colours,
// materials, details and features, instantly recognisable, with no
// neon, no glow and no sci-fi restyling on the item.
const DB_ART_IDENTICAL_RULE = "IDENTICAL-ITEM RULE: the item itself must be drawn identical to the real GTA VI item — the same shape, the same proportions, the same factory colours, the same materials, the same details and the same features, instantly recognisable as that exact item, as if rendered from the game's own model seen from a different angle. The item keeps its real-world colours and finishes (matte black metal, blued steel, wood furniture, factory paint, real skin, hair and clothing) — NO neon trim on the item, NO glowing parts, NO pink / teal / purple tint or colour grading on the item, NO futuristic or sci-fi redesign, nothing added, nothing removed, nothing restyled. Colour and mood live in the background and lighting only, never on the item itself.";
const DB_ART_STYLE = `Original fan-made illustration rendered with near-photorealistic, AAA game-render detail — realistic proportions, materials, reflections and lighting, sharp and clean, as close to an in-game render as an illustration can be, dark moody studio backdrop, dramatic rim lighting. ${DB_ART_IDENTICAL_RULE} An original illustration, not a photograph, not a screenshot, not a copy of any official artwork. No text, no logos, no badges, no watermark.`;
// Weapons sit on a completely flat solid dark navy background
// (the TRN cut-out style) — no studio backdrop, no gradient wash.
const DB_ART_STYLE_FLAT = `Original fan-made illustration rendered with near-photorealistic, AAA game-render detail — realistic proportions, materials, reflections and lighting, sharp and clean, as close to an in-game render as an illustration can be, on a completely flat solid very dark navy background — one flat colour, no gradient, no backdrop scenery. ${DB_ART_IDENTICAL_RULE} An original illustration, not a photograph, not a screenshot, not a copy of any official artwork. No text, no logos, no badges, no watermark.`;
// Avatar illustrations keep the older neon Vice City style brief —
// they are original Customise characters, not Database items, so
// the identical-item rule does not apply to them.
const AVATAR_ART_STYLE = "Original fan-made illustration rendered with near-photorealistic, AAA game-render detail — realistic proportions, materials, reflections and lighting, sharp and clean, as close to an in-game render as an illustration can be, in a neon pink, purple and teal Vice City palette, dark moody studio backdrop, dramatic rim lighting. An original illustration, not a photograph, not a screenshot, not a copy of any official artwork. No text, no logos, no badges, no watermark.";
const DB_ART_SPECS: Record<string, string> = {
  "Buccaneer": "a classic early-1970s American luxury muscle coupe in the shape of a Buick Riviera boattail — long hood, vinyl roof, sweeping rear, three-quarter front view on a neon-lit coastal street at dusk",
  "Buccaneer Custom": "an early-1970s American coupe turned lowrider custom with candy paint, chrome wire wheels and a lowered stance, three-quarter front view on a neon-lit street",
  "Chino": "a mid-1960s full-size American luxury coupe with hidden headlights, three-quarter front view on a neon-lit street",
  "Deviant": "a late-1960s fastback muscle coupe with a long nose and short rear deck, three-quarter front view on a neon-lit street",
  "Dominator": "a modern retro-styled American V8 muscle coupe in the unmistakable shape of a Mustang fastback — long hood, fastback roofline, tri-bar tail lights, deep red paint, three-quarter front view on a neon-lit coastal street at dusk",
  "Dominator ASP": "a modern Mustang-shaped American muscle coupe with a track aero kit, big rear wing, front splitter and racing stripes, three-quarter front view on a neon-lit street",
  "Dominator GT": "a modern Mustang-shaped American muscle convertible with the top down, three-quarter front view on a neon-lit coastal street",
  "Dominator GTX": "a wide-body high-performance Mustang-shaped American muscle coupe with aggressive aero and a vented hood, three-quarter front view on a neon-lit street",
  "Sabre Turbo": "an early-1970s A-body American muscle coupe with a hood scoop, three-quarter front view on a neon-lit street",
  "Sabre Turbo Custom": "an early-1970s American muscle coupe as a lowrider custom with candy paint and chrome, three-quarter front view on a neon-lit street",
  "Vigero": "a late-1960s American pony car coupe in the shape of a first-generation Camaro — long hood, coke-bottle hips, three-quarter front view on a neon-lit street at dusk",
  "Phoenix": "a late-1970s American sports coupe in the shape of a Trans Am — shaker hood scoop, T-top roof, snowflake wheels, three-quarter front view on a neon-lit street",
  "Gauntlet": "a modern retro American muscle coupe in the shape of a Dodge Challenger — broad shoulders, full-width tail light bar, three-quarter front view on a neon-lit street",
  "Dukes": "a late-1960s American muscle coupe in the unmistakable shape of a 1969 Charger — full-width grille, flying-buttress rear window, orange paint, three-quarter front view on a neon-lit street",
  "Stallion": "a late-1960s American convertible muscle car with the top down, three-quarter front view on a neon-lit coastal street",
  "Blade": "a mid-1960s compact American convertible with clean simple lines, three-quarter front view on a neon-lit street",
  "Hermes": "a late-1940s American lead-sled custom coupe with a chopped roof and smooth curves, three-quarter front view on a neon-lit street",
  "Hustler": "a 1930s American hot rod coupe with an exposed engine and big rear tyres, three-quarter front view on a neon-lit street",
  "Impaler": "a mid-1960s full-size American sedan, long and low, three-quarter front view on a neon-lit street",
  "Nightshade": "a mid-1970s American personal-luxury coupe with opera windows, three-quarter front view on a neon-lit street",
  "Ruiner": "a 1980s wedge-shaped sports coupe with pop-up headlights, three-quarter front view on a neon-lit street",
  "Slamvan": "a 1950s American pickup truck as a slammed lowrider custom with candy paint, three-quarter front view on a neon-lit street",
  "Tampa": "a late-1960s compact American muscle coupe, three-quarter front view on a neon-lit street",
  "Voodoo": "an early-1960s American lowrider sedan with candy paint, chrome and whitewall tyres, three-quarter front view on a neon-lit street",
  "556": "a realistic matte-black AR-15 / M4-pattern assault rifle — the GTA VI Duke 556, modelled on the Colt LE6920 — in a conventional layout with the magazine ahead of the pistol grip (NOT a bullpup, NOT futuristic, NOT sci-fi): carbine-length barrel with a triangular front sight post, carry handle with a rear sight on top of the receiver, ribbed cylindrical handguard, straight 30-round STANAG box magazine, plain matte black metal and polymer with a worn military finish, no attachments, no rails full of accessories, no coloured accents, no glow, no neon, side profile view",
  "ADB FRA": "a realistic matte-black FN FAL-pattern battle rifle — the GTA VI ADB FRA — NOT an AR-15, NOT an M16, no AR-style carry handle and no AR front sight tower: a long slender barrel with a slotted flash hider, a ribbed polymer handguard, a distinctive long receiver with a left-side charging handle, a strongly curved 20-round box magazine ahead of the pistol grip, and a straight buttstock in line with the barrel, plain matte black metal with dark polymer furniture and a worn military finish, no attachments, no coloured accents, no glow, no neon, side profile view",
  "Carbine": "an M4-style carbine assault rifle with a carry handle, quad rail and collapsible stock, side profile view on a dark studio backdrop",
  "Carbine Rifle Mk II": "an upgraded carbine rifle with a custom barrel, optics and tan furniture, side profile view on a dark studio backdrop",
  "Hillinger Heathen": "a compact modern assault rifle with a skeletal stock, side profile view on a dark studio backdrop",
  "Kozlov Hind": "an AK-pattern Eastern-bloc assault rifle with wooden furniture and a curved magazine, side profile view on a dark studio backdrop",
  "Kozlov KZ-59": "a vintage Eastern-bloc battle rifle with a wooden stock, side profile view on a dark studio backdrop",
  "Vom Feuer VF-G1": "a G36-pattern polymer assault rifle with an integrated carrying-handle optical sight and translucent magazine, side profile view on a dark studio backdrop",
  "Jason Duval": "a near-photorealistic AAA game-render character portrait with the same graphics style as GTA VI — the same face, facial features, hair and signature outfit as the game character, realistic skin and cinematic lighting, an original fan-made ViceSunshine illustration of the character (not a copy of any official Rockstar artwork, trailer still or screenshot): a rugged man in his mid-30s, short dark hair and stubble, sun-faded backwards cap and a plain faded t-shirt, calm wary expression, waist-up, neon-lit coastal street at night",
  "Lucia Caminos": "a near-photorealistic AAA game-render character portrait with the same graphics style as GTA VI — the same face, facial features, hair and signature outfit as the game character, realistic skin and cinematic lighting, an original fan-made ViceSunshine illustration of the character (not a copy of any official Rockstar artwork, trailer still or screenshot): a determined woman in her late 20s, long dark wavy hair and hoop earrings, confident defiant expression, casual street outfit with a crop top, waist-up, neon-lit coastal street at night",
  "Andrés de León": "a near-photorealistic AAA game-render character portrait with the same graphics style as GTA VI — the same face, facial features, hair and signature outfit as the game character, realistic skin and cinematic lighting, an original fan-made ViceSunshine illustration of the character (not a copy of any official Rockstar artwork, trailer still or screenshot) of a distinguished older man with silver-streaked hair and a sharp tailored suit, waist-up, neon-lit street at night",
  "Bae-Luxe": "a near-photorealistic AAA game-render character portrait with the same graphics style as GTA VI — the same face, facial features, hair and signature outfit as the game character, realistic skin and cinematic lighting, an original fan-made ViceSunshine illustration of the character (not a copy of any official Rockstar artwork, trailer still or screenshot) of a glamorous young woman in bold social-media-star fashion, waist-up, neon-lit street at night",
  "Boobie Ike": "a near-photorealistic AAA game-render character portrait with the same graphics style as GTA VI — the same face, facial features, hair and signature outfit as the game character, realistic skin and cinematic lighting, an original fan-made ViceSunshine illustration of the character (not a copy of any official Rockstar artwork, trailer still or screenshot) of a heavyset charismatic man with a gold chain and a wide grin, waist-up, neon-lit nightclub street at night",
  "Dre'quan Priest": "a near-photorealistic AAA game-render character portrait with the same graphics style as GTA VI — the same face, facial features, hair and signature outfit as the game character, realistic skin and cinematic lighting, an original fan-made ViceSunshine illustration of the character (not a copy of any official Rockstar artwork, trailer still or screenshot) of a young music producer with braids and studio headphones around his neck, waist-up, neon-lit street at night",
  "Kenton": "a near-photorealistic AAA game-render character portrait with the same graphics style as GTA VI — the same face, facial features, hair and signature outfit as the game character, realistic skin and cinematic lighting, an original fan-made ViceSunshine illustration of the character (not a copy of any official Rockstar artwork, trailer still or screenshot) of a laid-back man in casual streetwear with an easy smile, waist-up, neon-lit street at night",
  "Lori Heder": "a near-photorealistic AAA game-render character portrait with the same graphics style as GTA VI — the same face, facial features, hair and signature outfit as the game character, realistic skin and cinematic lighting, an original fan-made ViceSunshine illustration of the character (not a copy of any official Rockstar artwork, trailer still or screenshot) of a sharp professional woman with a no-nonsense expression in a professional outfit, waist-up, neon-lit street at night",
  "Elegy RH8": "a gunmetal-grey Japanese sports coupe in the shape of a Nissan GT-R — muscular haunches, quad round tail lights, big rear wing",
  "Sultan": "a blue Japanese rally sedan in the shape of a Subaru Impreza WRX — hood scoop, gold wheels, four doors, rally stance",
  "Banshee": "a red American roadster in the shape of a first-generation Dodge Viper — long hood, side exhausts, no roof, wide rear tyres",
  "Comet": "a silver German sports coupe in the shape of a Porsche 911 — round headlights, sloping rear deck, rear engine vents",
  "Coquette": "a black American sports coupe in the shape of a Corvette C7 — sharp creases, quad centre exhausts, low nose",
  "Feltzer": "a white German roadster in the shape of a Mercedes SL — long bonnet, chrome details, open top",
  "Jester": "a pearl-white Japanese hybrid sports coupe in the shape of an Acura NSX — angular LED lights, mid-engine intakes",
  "Massacro": "an orange British-Italian sports coupe in the shape of an Aston Martin Vanquish mixed with a Ferrari F12 — long sculpted hood",
  "Kuruma": "a dark-blue Japanese rally sedan in the shape of a Mitsubishi Lancer Evolution X — big rear wing, vented hood, aggressive front bumper",
  "Futo": "a small red 1980s Japanese coupe in the shape of a Toyota AE86 — boxy lines, pop-up headlights, black bumpers",
  "Penumbra": "a teal 1990s Japanese sports coupe in the shape of a Mitsubishi Eclipse — rounded bubble roof, integrated rear spoiler",
  "Carbonizzare": "a yellow Italian convertible grand tourer in the shape of a Ferrari California — folding hardtop down, long front deck",
  "Adder": "a black-and-orange French hypercar in the shape of a Bugatti Veyron — horseshoe grille, C-shaped side intake, two-tone body",
  "Zentorno": "a bright-green Italian hybrid hypercar in the shape of a Lamborghini Sesto Elemento — extreme angular aero, hexagonal details",
  "Turismo R": "a red Italian hybrid supercar in the shape of a LaFerrari — sharp nose, sculpted air channels, butterfly doors closed",
  "Infernus": "an orange Italian supercar in the shape of a Lamborghini Murciélago — scissor-door silhouette, huge rear intakes",
  "Vacca": "a yellow Italian supercar in the shape of a Lamborghini Gallardo — compact wedge shape, side blades",
  "Bullet": "a silver American supercar in the shape of a Ford GT — flying buttress rear, round tail lights, mid-engine vents",
  "Cheetah": "a classic red Italian supercar in the shape of a Ferrari Enzo — pointed nose, side air channels, quad tail lights",
  "Entity XF": "a white Swedish hypercar in the shape of a Koenigsegg Agera — wraparound windscreen, ghost-shaped rear lights",
  "Osiris": "a purple Italian hypercar in the shape of a Pagani Huayra — oval quad exhausts, gullwing silhouette, ornate mirrors",
  "T20": "a blue British hypercar in the shape of a McLaren P1 — swooping dihedral doors, teardrop cabin, active rear wing",
  "Z-Type": "a burgundy 1930s luxury coupe in the shape of a Bugatti Type 57 Atlantic — teardrop fenders, dorsal seam fin",
  "Monroe": "a silver 1960s Italian sports coupe in the shape of a Lamborghini Miura — eyelash headlight surrounds, side slats",
  "JB 700": "a silver 1960s British grand tourer in the shape of an Aston Martin DB5 — chrome bumpers, elegant fastback roof",
  "Stinger": "a cream 1960s Italian convertible in the shape of a Ferrari 250 California — open top, chrome wire wheels",
  "Coquette Classic": "a red 1960s American sports car in the shape of a Corvette C2 Sting Ray — split rear window, side pipes",
  "Casco": "a dark-green 1960s Italian grand tourer in the shape of a Maserati 3500 GT — oval grille, long elegant hood",
  "Mamba": "a British racing-green 1960s roadster in the shape of an AC Cobra — flared arches, side exhaust, open cockpit",
  "Stirling GT": "a silver 1950s German gullwing coupe in the shape of a Mercedes 300SL — gullwing doors closed, eyebrow arches",
  "Exemplar": "a champagne German four-door coupe in the shape of a Mercedes CLS — frameless windows, sweeping roofline",
  "Jackal": "a grey British executive saloon in the shape of a Jaguar XF — mesh grille, sleek four-door body",
  "Felon": "a black British luxury sedan in the shape of a Jaguar XJ — long wheelbase, chrome window trim",
  "Felon GT": "a dark-red British luxury convertible in the shape of a Jaguar XK — open top, long bonnet",
  "Oracle": "a silver German executive sedan in the shape of a BMW 7 Series — kidney grille, formal three-box shape",
  "Zion": "a blue German coupe in the shape of a BMW 6 Series — shark nose, muscular rear haunches",
  "Sentinel": "a white German convertible in the shape of a BMW 3 Series cabrio — open top, compact executive shape",
  "F620": "a grey Italian-British grand tourer in the shape of a Maserati GranTurismo — oval grille, long hood, four exhausts",
  "Tailgater": "a silver German sport sedan in the shape of an Audi A6 — single-frame grille, understated four-door body",
  "Schafter": "a black German luxury sedan in the shape of a Mercedes S-Class — upright grille, formal limousine proportions",
  "Washington": "a beige American full-size sedan in the shape of a Lincoln Town Car — chrome trim, vinyl roof",
  "Primo": "a faded gold 1980s American sedan in the shape of a Cadillac DeVille — boxy chrome-bumpered body",
  "Stanier": "a white American police-style sedan in the shape of a Ford Crown Victoria — plain steel wheels, three-box shape",
  "Ingot": "a maroon Swedish estate wagon in the shape of a Volvo 945 — boxy rear, vertical tail lights",
  "Asterope": "a silver Japanese family sedan in the shape of a Toyota Camry — plain aerodynamic four-door body",
  "Fugitive": "an Australian-style V8 sedan in the shape of a Holden Caprice — muscular four-door, dual exhausts",
  "Baller": "a black British luxury SUV in the shape of a Range Rover — floating roof, clamshell bonnet, upright grille",
  "Huntley S": "a dark-green British luxury SUV in the shape of a Bentley Bentayga concept — round lights, mesh grille, opulent stance",
  "Rocoto": "a grey German compact SUV in the shape of a Porsche Cayenne — sloping roof, four-point headlights",
  "Astron": "a silver-grey luxury compact SUV in the shape of a Porsche Macan — rounded fastback roofline, full-width rear light bar, large five-spoke alloy wheels, three-quarter front studio view, whole vehicle centred and fully in frame, plain dark studio backdrop, no other vehicles, no people",
  "ADB M350": "a modern belt-fed light machine gun with a boxy receiver, top carry handle, perforated barrel shroud and a draped ammunition belt, alone in side profile, centred on a plain dark studio backdrop, no people, no hands",
  "Dubsta": "a tan German military SUV in the shape of a Mercedes G-Wagen — flat panels, round headlights, roof rack",
  "Gresley": "a silver American mid-size SUV in the shape of a Dodge Durango — crosshair grille, muscular shoulders",
  "Mesa": "an olive American off-road SUV in the shape of a Jeep Wrangler — seven-slot grille, removable top, spare wheel on the tailgate",
  "Patriot": "a huge black American SUV in the shape of a Hummer H2 — flat windscreen, seven vertical grille slots",
  "Radius": "a silver American crossover SUV in the shape of a Ford Edge — sloping hatch, chrome grille bars",
  "Rancher XL": "a faded two-tone 1980s American full-size SUV in the shape of a Chevy Suburban K10 — square body, raised suspension, off-road tyres",
  "Blazer": "a red-and-white sport quad bike (ATV) with chunky off-road tyres, exposed frame and a single seat",
  "Caracara 4x4": "a silver modern American off-road pickup in the shape of a Ford F-150 Raptor — wide fender flares, skid plate, all-terrain tyres",
  "Kamacho": "a bright-green off-road pickup concept truck with a roll cage in the bed, huge all-terrain tyres and a snorkel",
  "Liberator": "a stars-and-stripes American monster truck with enormous tractor tyres, exposed suspension and a flag on the cab",
  "Hellion": "a lifted Japanese 4x4 pickup in the shape of a Nissan Patrol Safari conversion — bull bar, roof lights, mud tyres",
  "Sandking XL": "a yellow lifted American crew-cab pickup with a suspension lift, bull bar and oversized off-road tyres",
  "Rebel": "a rusty beige Japanese compact pickup in the shape of a Toyota Hilux — roll bar, battered panels, off-road tyres",
  "Dune Buggy": "an open-frame beach buggy with a fibreglass tub body, exposed engine at the rear and paddle tyres",
  "Dubsta 6x6": "a matte-black six-wheeled German luxury pickup in the shape of a Mercedes G63 AMG 6x6 — three axles, portal hubs, pickup bed",
  "Dominator Buggy": "a classic American muscle coupe rebuilt as an off-road buggy — lifted suspension, knobbly tyres, roof light bar, stripped bodywork",
  "Bobcat XL": "a faded blue 1970s American stepside pickup truck — chrome bumpers, wooden bed rails",
  "Sadler": "a plain white American work pickup truck with steel wheels and a long bed",
  "Bison": "a dark-grey modern American crew-cab pickup in the shape of a Dodge Ram — crosshair grille, chrome mirrors",
  "Bodhi": "a tan open-top 4x4 pickup in the shape of a Land Rover Defender 110 crew cab — canvas roof, snorkel, steel wheels",
  "Contender": "a modern American super-crew pickup in the shape of a Ford Super Duty — huge chrome grille, dually-style stance",
  "Bati 801": "a red Italian superbike in the shape of a Ducati 848 — twin undertail exhausts, single-sided swingarm, full fairing",
  "Akuma": "a black Japanese naked street bike in the shape of a Yamaha MT-09 — exposed engine, minimal bodywork, upright bars",
  "PCJ 600": "a blue 1990s Japanese sports bike in the shape of a Honda CBR600 — full fairing, twin headlights",
  "Sanchez": "an orange dirt bike in the shape of a KTM EXC — knobbly tyres, high front fender, slim motocross body",
  "Double T": "a purple custom Japanese sports bike in the shape of a Kawasaki ZX-10R with an extended swingarm",
  "Hakuchou": "a silver Japanese drag bike in the shape of a Suzuki Hayabusa — long aerodynamic fairing, humped tail",
  "Ruffian": "an Italian naked roadster bike in the shape of a Ducati Monster — trellis frame, round headlight",
  "Vader": "a green Japanese supermoto bike — tall stance, road tyres on spoked wheels, compact body",
  "Lectro": "a realistic electric sports motorcycle with a smooth enclosed fairing in plain dark grey and black, ordinary road-bike proportions and real tyres, bars and lights, no glowing parts, no futuristic styling",
  "Enduro": "a green dual-sport enduro motorcycle with a headlight mask, hand guards and semi-knobbly tyres",
  "Faggio": "a pastel-blue Italian step-through scooter in the shape of a Vespa — leg shield, round headlight, small wheels",
  "BMX": "a simple chrome BMX bicycle with a small frame, single gear and pegs",
  "Scorcher": "a rugged mountain bike with front suspension, disc brakes and knobbly tyres",
  "Speeder": "a sleek white-and-teal Italian speedboat with a pointed bow and twin outboard engines, on a dark studio backdrop with waterline reflections",
  "Jetmax": "a long black offshore powerboat with a closed bow and twin exhausts, on a dark studio backdrop with waterline reflections",
  "Squalo": "a white family speedboat with an open bow and a wakeboard tower, on a dark studio backdrop with waterline reflections",
  "Suntrap": "a small white sailing boat with a single mast and furled sails, on a dark studio backdrop with waterline reflections",
  "Marquis": "a large wooden-hulled sailing yacht with two masts and cream sails furled, on a dark studio backdrop with waterline reflections",
  "Seashark": "a bright-yellow personal watercraft (jet ski) with handlebars and a two-person seat, on a dark studio backdrop with waterline reflections",
  "Dinghy": "a small grey inflatable dinghy with an outboard motor, on a dark studio backdrop with waterline reflections",
  "Tropic": "a white cabin cruiser boat with a flybridge and radar arch, on a dark studio backdrop with waterline reflections",
  "Luxor": "a white private jet in the shape of a Gulfstream — oval windows, T-tail, rear-mounted twin engines, on a dark studio backdrop",
  "Velum": "a white five-seat propeller plane in the shape of a Cirrus SR22 — low wing, fixed gear, sleek cabin",
  "Duster": "a yellow crop-duster biplane in the shape of a Grumman Ag Cat — two wings, spray hopper, radial engine",
  "Mallard": "a red-and-white stunt plane in the shape of a Pitts Special — small biplane with aerobatic markings abstracted, no text",
  "Cuban 800": "a white twin-engine propeller plane in the shape of a Piper Aztec — low wing, two propellers",
  "Dodo": "a white seaplane in the shape of a de Havilland Beaver — high wing, twin floats, single propeller",
  "Hydra": "a grey VTOL fighter jet in the shape of a Harrier jump jet — lift fan doors, single-seat canopy, wing pylons",
  "Besra": "a grey military jet trainer in the shape of a BAE Hawk — tandem canopy, straight wing, single engine",
  "Buzzard": "a small black attack helicopter in the shape of an MH-6 Little Bird — bubble canopy, rocket pods, skids",
  "Maverick": "a white-and-blue civilian helicopter in the shape of a Bell 206 JetRanger — bubble windows, skids, tail rotor",
  "Frogger": "a green-and-white executive helicopter in the shape of a Eurocopter EC130 — fenestron tail, wide cabin windows",
  "Annihilator": "a matte-black stealth attack helicopter in the shape of a Comanche concept — faceted body, enclosed tail fan",
  "Cargobob": "a huge twin-rotor cargo helicopter in the shape of a CH-47 Chinook — rotors at both ends, rear loading ramp, cargo hook",
  "Swift": "a sleek white luxury helicopter in the shape of an AgustaWestland AW139 — retractable gear, pointed nose",
  "Police Cruiser": "a black-and-white American police sedan with a light bar and push bumper, no readable text",
  "Sheriff SUV": "a white sheriff SUV with a light bar, bull bar and off-road tyres, no readable text",
  "Ambulance": "a white box ambulance with red stripes and emergency lights, no readable text",
  "Fire Truck": "a red American fire engine with ladders, hoses and chrome fittings, no readable text",
  "Police Riot": "a dark armoured police riot vehicle with mesh-covered windows and a water cannon",
  "Tipper": "an orange construction dump truck with a raised-capacity tipper bed and mud flaps",
  "Flatbed": "a grey flatbed recovery truck with a sliding bed and wheel lift",
  "Mixer": "a white-and-blue cement mixer truck with a rotating drum",
  "Dozer": "a yellow bulldozer with a wide front blade and caterpillar tracks",
  "Dump": "a massive yellow mining dump truck with six huge wheels and a towering tipper bed",
  "Bus": "a teal-and-white city transit bus with large windows and a destination blind showing abstract shapes, no readable text",
  "Trashmaster": "a green rear-loading garbage truck with a compactor body and hydraulic arms",
  "Taxi": "a yellow American taxi sedan with a roof sign showing abstract shapes, no readable text",
  "Tourbus": "a white open-top double-decker tour bus with sightseeing passengers abstracted, no readable text",
  "Airtug": "a small yellow airport baggage tug with a low flat body",
  "Forklift": "a small orange warehouse forklift with raised forks and a safety cage",
  "Lawn Mower": "a green ride-on lawn mower with a mid-mounted cutting deck",
  "Tractor": "a red farm tractor with huge rear wheels and an exhaust stack",
  "Caddy": "a small white golf cart with a canopy roof and bench seat",
  "Burrito": "a plain white American panel van with sliding doors and steel wheels",
  "Pony": "a faded red compact delivery van with a boxy cargo body",
  "Rumpo": "a blue news-style van with a roof equipment pod, no readable text",
  "Speedo": "a grey express delivery van with a tall roof and sliding door",
  "Surfer": "a two-tone 1960s camper van in the shape of a VW Type 2 — split windscreen, surfboard on the roof rack",
  "Youga": "a white Japanese compact van in the shape of a Toyota Hiace — cab-over shape, sliding doors",
  "Minivan": "a silver American family minivan in the shape of a Dodge Caravan — sliding doors, roof rails",
  "Pistol": "a compact black semi-automatic pistol with a polymer frame, side profile on a dark studio backdrop",
  "Combat Pistol": "a black tactical semi-automatic pistol with an accessory rail and extended magazine, side profile on a dark studio backdrop",
  "AP Pistol": "a black fully-automatic machine pistol with a long extended magazine and threaded barrel, side profile on a dark studio backdrop",
  "SNS Pistol": "a tiny silver pocket pistol with a short barrel, side profile on a dark studio backdrop",
  "Heavy Pistol": "a large stainless heavy-calibre semi-automatic pistol with wooden grips, side profile on a dark studio backdrop",
  "Vintage Pistol": "an ornate antique-style semi-automatic pistol with engraved details and pearl grips, side profile on a dark studio backdrop",
  "Heavy Revolver": "a huge stainless magnum revolver with a long vented barrel and rubber grips, side profile on a dark studio backdrop",
  "Morgan Revolver": "a classic blued-steel single-action revolver with a wooden grip, side profile on a dark studio backdrop",
  "Mustang .357 Revolver": "a polished nickel .357 magnum revolver with a medium barrel, side profile on a dark studio backdrop",
  "Nipper .38": "a small snub-nose .38 revolver with a short barrel and compact grip, side profile on a dark studio backdrop",
  "Sand Storm ES9": "a tan desert-coloured modern semi-automatic pistol with a rail, side profile on a dark studio backdrop",
  "Schlamm DRX": "a black modern striker-fired pistol with angular slide cuts, side profile on a dark studio backdrop",
  "Scorpio Akulus": "an oversized silver revolver with an extra-long slab-sided barrel, side profile on a dark studio backdrop",
  "The Silver 1922": "a vintage 1920s-style semi-automatic pistol with a blued finish and wooden grips, side profile on a dark studio backdrop",
  "Wortham WCR1": "a compact silver snub revolver with a shrouded hammer, side profile on a dark studio backdrop",
  "Micro SMG": "a compact black machine pistol in the shape of a Micro Uzi with a folding stock, side profile on a dark studio backdrop",
  "SMG": "a black submachine gun in the shape of an MP5 with a fixed stock and curved magazine, side profile on a dark studio backdrop",
  "Assault SMG": "a black bullpup-style submachine gun in the shape of a P90 with a top-loading magazine, side profile on a dark studio backdrop",
  "Combat PDW": "a compact grey personal-defence weapon in the shape of an MP7 with a retractable stock, side profile on a dark studio backdrop",
  "Machine Pistol": "a small black machine pistol in the shape of a Tec-9 with a long magazine, side profile on a dark studio backdrop",
  "Pump Shotgun": "a black pump-action shotgun with a wooden fore-end and long barrel, side profile on a dark studio backdrop",
  "Sawed-Off Shotgun": "a short double-barrel shotgun with sawn barrels and a pistol grip, side profile on a dark studio backdrop",
  "Assault Shotgun": "a black semi-automatic combat shotgun with a drum magazine in the shape of an AA-12, side profile on a dark studio backdrop",
  "Bullpup Shotgun": "a bullpup semi-automatic shotgun with the magazine behind the grip, side profile on a dark studio backdrop",
  "Musket": "an antique flintlock musket with a long wooden stock and brass fittings, side profile on a dark studio backdrop",
  "Heavy Shotgun": "a heavy black semi-automatic shotgun with a thick barrel and box magazine, side profile on a dark studio backdrop",
  "Assault Rifle": "an AK-pattern assault rifle with wooden furniture and a curved magazine, side profile on a dark studio backdrop",
  "Advanced Rifle": "a bullpup assault rifle in the shape of a TAR-21 with an integrated sight, side profile on a dark studio backdrop",
  "Special Carbine": "a tan special-forces carbine with a free-float rail, optics and suppressor, side profile on a dark studio backdrop",
  "Bullpup Rifle": "a bullpup rifle in the shape of a FAMAS with a large carrying handle, side profile on a dark studio backdrop",
  "MG": "a belt-fed general-purpose machine gun in the shape of an MG42 with a bipod, side profile on a dark studio backdrop",
  "Combat MG": "a modern belt-fed light machine gun with a box magazine and railed handguard, side profile on a dark studio backdrop",
  "Gusenberg Sweeper": "a 1920s drum-magazine submachine gun in the shape of a Thompson with a foregrip, side profile on a dark studio backdrop",
  "Sniper Rifle": "a bolt-action sniper rifle with a long barrel, bipod and large scope, side profile on a dark studio backdrop",
  "Heavy Sniper": "an oversized anti-materiel sniper rifle in the shape of a Barrett .50 cal with a muzzle brake, side profile on a dark studio backdrop",
  "Marksman Rifle": "a semi-automatic designated marksman rifle with a medium scope and bipod, side profile on a dark studio backdrop",
  "RPG": "a shoulder-fired rocket launcher in the shape of an RPG-7 with a conical warhead, side profile on a dark studio backdrop",
  "Grenade Launcher": "a rotary multi-shot grenade launcher with a large cylinder, side profile on a dark studio backdrop",
  "Minigun": "a six-barrel rotary minigun with an ammunition belt and carry frame, side profile on a dark studio backdrop",
  "Railgun": "a bulky experimental railgun in matte gunmetal grey with twin parallel rails and heavy cabling, worn industrial metal finish, no glowing parts, no coloured accents, side profile on a dark studio backdrop",
  "Homing Launcher": "a shoulder-fired guided missile launcher with a boxy targeting unit, side profile on a dark studio backdrop",
  "Hillinger Boomer": "a single-shot break-action grenade launcher with a wooden stock in the shape of an M79, side profile on a dark studio backdrop",
  "Knife": "a black tactical combat knife with a serrated edge, side profile on a dark studio backdrop",
  "Baseball Bat": "a wooden baseball bat with a worn barrel, side profile on a dark studio backdrop",
  "Crowbar": "a red steel crowbar with a curved claw end, side profile on a dark studio backdrop",
  "Golf Club": "a steel golf iron with a leather grip, side profile on a dark studio backdrop",
  "Nightstick": "a black police nightstick with a side handle, side profile on a dark studio backdrop",
  "Hammer": "a heavy claw hammer with a wooden handle, side profile on a dark studio backdrop",
  "Machete": "a long machete with a broad blade and wrapped handle, side profile on a dark studio backdrop",
  "Battle Axe": "a medieval-style battle axe with a steel head and wooden haft, side profile on a dark studio backdrop",
  "Brian Heder": "a near-photorealistic AAA game-render character portrait with the same graphics style as GTA VI — the same face, facial features, hair and signature outfit as the game character, realistic skin and cinematic lighting, an original fan-made ViceSunshine illustration of the character (not a copy of any official Rockstar artwork, trailer still or screenshot) of a weathered older man with a grey beard and a faded red Hawaiian shirt, leaning over a map table, waist-up, neon-lit street at night",
  "Cal Hampton": "a near-photorealistic AAA game-render character portrait with the same graphics style as GTA VI — the same face, facial features, hair and signature outfit as the game character, realistic skin and cinematic lighting, an original fan-made ViceSunshine illustration of the character (not a copy of any official Rockstar artwork, trailer still or screenshot) of a laid-back young man with a backwards cap, sunglasses and a loud floral shirt, holding a drink, waist-up, neon-lit street at night",
  "Raul Bautista": "a near-photorealistic AAA game-render character portrait with the same graphics style as GTA VI — the same face, facial features, hair and signature outfit as the game character, realistic skin and cinematic lighting, an original fan-made ViceSunshine illustration of the character (not a copy of any official Rockstar artwork, trailer still or screenshot) of a sharp-dressed man with slicked hair and sunglasses in a cream suit, adjusting his cufflinks, waist-up, neon-lit street at night",
  "Roxy": "a near-photorealistic AAA game-render character portrait with the same graphics style as GTA VI — the same face, facial features, hair and signature outfit as the game character, realistic skin and cinematic lighting, an original fan-made ViceSunshine illustration of the character (not a copy of any official Rockstar artwork, trailer still or screenshot) of a confident young woman in bold street fashion with statement jewellery, one half of a music duo, waist-up, neon-lit street at night",
  "One Eyed Willies": "the storefront of a greasy spoon diner and mod garage with a big eye-shaped neon sign (abstract shapes, no readable text), a lifted green pickup on a lift inside the open garage bay, dusk",
  "Rideout Customs": "the storefront of a custom car workshop with an open shutter, a gold classic coupe on jacks inside, tools and neon glow, dusk",
  "Big Shots Wholesale Weapons": "the storefront of a wholesale gun store with barred windows and a plain awning, abstract sign shapes with no readable text, dusk",
  "Island Dreams": "a small island bait-and-tackle shack on a wooden dock with boats moored behind it, palm trees and turquoise water, golden hour",
  "Jack of Hearts": "the storefront of a neon-lit nightclub with a glowing heart-and-spade sign (abstract shapes, no readable text), queue barriers outside, night",
  "Key Lento Fire Department": "a small island fire station with two red fire engines parked outside, palm trees and a flag pole, daytime",
  "Mami's Grocery Market": "a small corner grocery market with fruit crates outside, a striped awning and locals' bicycles, warm afternoon light, no readable text",
  "Megamundo": "a huge multi-storey shopping centre at night with glowing abstract signage shapes, escalators visible through glass, no readable text",
  "The Rusty Anchor": "a weathered waterfront bar with a rusty anchor sign, wooden deck and boats in the harbour behind it, sunset",
  "Three Sheets Liquor": "a small liquor store with a red-and-black striped awning and a yellow pickup parked outside, bright daytime, no readable text",
  "Venture Apartments": "a pastel art-deco apartment block at night with neon trim, balconies and a figure climbing the fire escape, moody light",
  "Jason's Safehouse": "a weathered teal stilt house on the coast with a wooden deck, an orange muscle car parked underneath and a boat nearby, golden hour",
  "Lucia's Apartment": "a peach-coloured walk-up apartment block in the city with balconies, laundry lines and neon glow from the street below, dusk",
  "Paradise Garage": "a concrete storage garage with the shutter half open, a muddy off-road muscle buggy parked inside, tools and spare tyres, dusk",
  "Electric Fang Tattoo": "the storefront of a tattoo parlour at night with a huge glowing orange fang-and-wolf neon sign (abstract shapes, no readable text), a scooter parked outside",
};

async function generateDbArtFor(ctx: Ctx, entry: typeof schema.dbEntries.$inferSelect): Promise<boolean> {
  const spec = DB_ART_SPECS[entry.name]
    ?? (entry.kind === "Vehicle"
      ? `a ${entry.category.toLowerCase()} vehicle called the ${entry.name}, with its own distinct body shape and colour`
      : entry.kind === "Weapon"
        ? `a ${entry.category.toLowerCase()} weapon called the ${entry.name}, side profile view on a flat solid dark navy background`
        : entry.kind === "Location"
          ? `the storefront of a ${entry.category.toLowerCase()} location called ${entry.name} on a neon coastal street`
          : `a character portrait of ${entry.name}`);
  // Framing rules (v4, owner's TRN-study direction): the Database
  // pictures follow TRN's framing per kind — Vehicles in-world at
  // 16:9 with varied framing, Weapons as flat cut-outs, Characters
  // as standardised 3:4 portraits with the face in the upper
  // third, Locations as wide eye-level exteriors. Every subject is
  // drawn EXACTLY as it is established in GTA VI — same face, same
  // features, same details, nothing added, nothing redesigned,
  // nothing changed — but as an original illustration from a
  // fresh viewpoint official artwork does not use.
  const vehicleAngles = ["three-quarter front view", "side profile view", "rear three-quarter view", "a tight front three-quarter close crop", "a wide in-world view"];
  const vehicleSettings = ["a neon-lit Vice City street at night", "a coastal causeway at golden hour", "a rain-slick downtown street under neon signs at night", "a beachfront boulevard at dusk", "a neon-lit Leonida Keys marina road at night"];
  const vehicleAngle = vehicleAngles[entry.id % vehicleAngles.length] ?? vehicleAngles[0];
  const vehicleSetting = vehicleSettings[entry.id % vehicleSettings.length] ?? vehicleSettings[0];
  const weaponCompact = /pistol|handgun|revolver|melee/i.test(entry.category) || /pistol|revolver/i.test(entry.name);
  const framing =
    entry.kind === "Vehicle"
      ? `Composition: an in-world shot of this one vehicle only — ${vehicleAngle}, the whole vehicle fully in frame and the clear subject filling most of the frame, on ${vehicleSetting}. The vehicle exactly as it is in GTA VI — same body, same details, nothing redesigned, nothing added — from a fresh viewpoint official artwork does not use. No other vehicles, no people, no readable text or logos.`
      : entry.kind === "Character"
        ? "Composition: a waist-up portrait of this one person only, seen from a fresh three-quarter viewpoint official artwork does not use — face in the upper third of the frame, head fully in frame with clear headroom above it, face and upper body centred at a consistent character-portrait scale, plain dark studio backdrop with neon rim light. Not a street scene, not a cityscape, no skyline, no other people. FACIAL FIDELITY IS MANDATORY: the face must match the character's established GTA VI look exactly — same face, same features, same hair, recognisable as that exact character. Facial hair ONLY where the description above explicitly states it (stated stubble, a stated beard); where the description states none, the character is clean-shaven — do NOT add a beard, a moustache, extra hair, scars, tattoos, glasses or any feature the character does not have. Nothing added, nothing changed."
        : entry.kind === "Location"
          ? "Composition: a wide, tightly cropped, eye-level exterior shot of this one location only, from a slight street-corner angle official artwork does not use — the building fills the frame, centred or slightly left, foreground street / lot across the bottom of the frame, sky / roof across the top, dusk light with neon rim light. The location exactly as established — same building, same details, nothing added. No readable text on any sign (abstract glowing shapes only), no logos, no close-up people."
          : `Composition: the weapon alone as a clean cut-out floating on a completely flat solid very dark navy background — one flat colour, no gradient, no environment, no floor, no scenery — horizontal side profile, barrel pointing right, stock / grip to the left, centred vertically. The weapon exactly as it is in GTA VI — same shape, same details, nothing redesigned, nothing added. ${weaponCompact ? "Shown at a natural smaller scale in the middle of the frame with generous empty dark space around it — do NOT enlarge it to fill the frame." : "The weapon stretches across 85–100% of the frame width."}`;
  try {
    // Every repaint lands under a FRESH versioned blob key
    // (db-art/entry-<id>-v<n>, n from meta db_art_versions). The
    // previous build repainted over the SAME key, so the picture's
    // URL never changed and browsers / CDNs kept serving the old
    // cached image — a finished repaint looked exactly like nothing
    // had changed. A new key = a new URL = the new picture shows.
    let versions: Record<string, number> = {};
    try {
      versions = JSON.parse((await getMeta(ctx, "db_art_versions")) || "{}") as Record<string, number>;
    } catch {
      versions = {};
    }
    const nextVersion = (versions[String(entry.id)] ?? 0) + 1;
    const media = await ctx.tool.generate_media(
      `Paint ${spec}. ${framing} This is original fan artwork for a community database — an illustration inspired by the item, not a copy of any official artwork. ${entry.kind === "Weapon" ? DB_ART_STYLE_FLAT : DB_ART_STYLE}`,
      { key: `db-art/entry-${entry.id}-v${nextVersion}`, orientation: entry.kind === "Character" ? "portrait" : "landscape" },
    );
    const db = ctx.db<typeof schema>();
    await db
      .update(schema.dbEntries)
      .set({ imageBlobKey: media.blobKey, updatedAt: new Date() })
      .where(eq(schema.dbEntries.id, entry.id));
    versions[String(entry.id)] = nextVersion;
    await setMeta(ctx, "db_art_versions", JSON.stringify(versions));
    return true;
  } catch (e) {
    // Never swallow a generation failure silently again: the last
    // failure is kept in meta db_art_last_error so a stalled repaint
    // is diagnosable instead of looking like "nothing changed".
    try {
      await setMeta(ctx, "db_art_last_error", JSON.stringify({
        entryId: entry.id,
        name: entry.name,
        message: e instanceof Error ? e.message : String(e),
        at: new Date().toISOString(),
      }));
    } catch { /* the failure record itself must never throw */ }
    return false;
  }
}

const AVATAR_DEFS: { id: string; spec: string }[] = [
  { id: "street", spec: "an original character portrait of a confident young street-style character wearing a cap and hoodie with a gold chain, waist-up" },
  { id: "crew", spec: "an original character portrait of a loyal crew member wearing a bomber jacket with an easy grin, waist-up" },
  { id: "driver", spec: "an original character portrait of a cool driver wearing sunglasses and a leather jacket, car keys in hand, waist-up" },
  { id: "surfer", spec: "an original character portrait of a relaxed surfer with sun-bleached hair and a surfboard under one arm, waist-up" },
  { id: "racer", spec: "an original character portrait of a street racer wearing a racing jacket with a determined look, waist-up" },
  // Premium-exclusive avatars (Customise catalogue, premiumOnly) —
  // generated the same way, only ever equippable with Premium.
  { id: "neon-outlaw", spec: "an original character portrait of a neon outlaw wearing a glowing hot-pink visor and a black jacket with teal neon trim, confident smirk, waist-up" },
  { id: "alien-visitor", spec: "an original character portrait of a stylish friendly alien visitor with smooth teal-green skin and large dark eyes, wearing a silver Vice City jacket, cool and calm, waist-up" },
  { id: "supercar-ace", spec: "an original character portrait of a supercar ace driver wearing a sleek black-and-pink racing suit, holding a supercar key fob, waist-up" },
];


// ---- Automatic content moderation ----
// Every piece of public user content (Feed posts and comments,
// quote reposts, clan chat, guides, LFG posts, events, clan names,
// profiles, bug reports, Easter egg reports) is screened by
// screenText BEFORE it is stored: explicit sexual content and
// nudity, sexual content involving minors (illegal — always
// blocked), leaked / pirated / illegal download offers, scams,
// real-world illegal trade, severe hate slurs, and personal contact
// details in public posts. Media links are screened separately:
// direct file-download links are blocked (videos are shared from
// YouTube / TikTok, which play in the embedded players). Anything
// that slips through can be reported — 3 reports flag a post and
// hide it from everyone but its author — and the hourly
// automationSweep re-screens recent content and flags or removes
// anything that now matches. Screening is pattern-based, so its
// messages always offer a human review via a support request.
function screenText(raw: string, allowContact = false): string | null {
  const flat = raw.toLowerCase();
  const t = ` ${flat.replace(/[^a-z0-9@$ ]+/g, " ").replace(/\s+/g, " ")} `;
  const leet = t
    .replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a")
    .replace(/5/g, "s").replace(/7/g, "t").replace(/@/g, "a").replace(/\$/g, "s");
  const has = (re: RegExp) => re.test(t) || re.test(leet);
  if (
    has(/\b(child|children|minor|minors|kid|kids|teen|underage|preteen|schoolgirl|schoolboy|loli)\b[^.]{0,40}\b(sex|porn|nude|nudes|naked|erotic|xxx)\b/) ||
    has(/\b(sex|porn|nude|nudes|naked|erotic|xxx)\b[^.]{0,40}\b(child|children|minor|minors|kid|kids|teen|underage|preteen)\b/)
  ) {
    return "sexual content involving minors is illegal and is never allowed here";
  }
  if (has(/\b(porn|porno|xxx|nudes?|naked pics|onlyfans|sex tape|hardcore|erotic pics|nsfw)\b/)) {
    return "explicit sexual content and nude pictures or videos are not allowed";
  }
  if (
    has(/\b(leaked|leak)\b[^.]{0,40}\b(download|link|footage|gameplay|full game|build)\b/) ||
    has(/\b(download|get)\b[^.]{0,30}\b(leaked|pirated|cracked)\b/) ||
    has(/\b(free download|cracked version|pirated copy|torrent|magnet link|iso download|full game free)\b/) ||
    has(/\bgta ?(vi|6)\b[^.]{0,30}\b(free download|crack|pirated|torrent)\b/)
  ) {
    return "leaked, pirated or illegally downloaded content is not allowed — ViceSunshine only links official sources";
  }
  if (
    has(/\b(credit|money|cash|premium|robux|vbucks)\b[^.]{0,25}\b(generator|hack|duplication|doubling)\b/) ||
    has(/\b(send|give|type|enter|share)\b[^.]{0,25}\b(password|login|verification code|bank details|card number)\b/) ||
    has(/\b(double your|free gift ?card|claim your prize)\b/)
  ) {
    return "this looks like a scam — 'free' generators and requests for passwords, codes or card details are not allowed";
  }
  if (has(/\b(buy|sell|selling)\b[^.]{0,25}\b(cocaine|heroin|meth|fentanyl|illegal guns|stolen cards|fake id)\b/)) {
    return "real-world illegal trade is not allowed (in-game GTA talk is fine — real buying and selling is not)";
  }
  if (has(/\b(nigger|nigga|faggot|kike|spic|chink|tranny)\b/)) {
    return "hate slurs are not allowed";
  }
  if (!allowContact) {
    if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/.test(flat) || /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(raw)) {
      return "personal contact details (email addresses, phone numbers) are not allowed in public posts — keep them in your private Settings fields";
    }
  }
  return null;
}

// Profile names get a stricter screen than posts (owner's
// direction): on top of everything screenText blocks, a username
// or display name may not carry profanity, and may not impersonate
// Rockstar Games / Take-Two — ViceSunshine is unofficial, and a
// name pretending to be the official studio is a legal and trust
// problem. Applied at account creation and every profile save, and
// re-checked by the hourly sweep + the owner dashboard queue.
function screenProfileName(raw: string): string | null {
  const base = screenText(raw);
  if (base) return base;
  const flat = raw.toLowerCase();
  const t = ` ${flat.replace(/[^a-z0-9@$ ]+/g, " ").replace(/\s+/g, " ")} `;
  const leet = t
    .replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a")
    .replace(/5/g, "s").replace(/7/g, "t").replace(/@/g, "a").replace(/\$/g, "s");
  const has = (re: RegExp) => re.test(t) || re.test(leet);
  if (has(/\b(fuck|shit|bitch|cunt|whore|slut|dick|cock|pussy|bastard|wank|porn|sex)\b/)) {
    return "profile names can't contain profanity or sexual words — pick a name everyone can see";
  }
  const squashed = flat.replace(/[^a-z]/g, "");
  if (squashed.includes("rockstar") || squashed.includes("taketwo")) {
    return "that name impersonates Rockstar Games / Take-Two — ViceSunshine is an unofficial fan community, so official studio names can't be used as a profile name";
  }
  return null;
}

function assertNameClean(...names: string[]): void {
  for (const name of names) {
    const reason = screenProfileName(name);
    if (reason) {
      throw new Error(
        `Blocked by automatic moderation: ${reason}. If you think this is a mistake, ask Vice to open a support request for a human review.`,
      );
    }
  }
}

function assertClean(...texts: string[]): void {
  for (const text of texts) {
    const reason = screenText(text);
    if (reason) {
      throw new Error(
        `Blocked by automatic moderation: ${reason}. If you think this is a mistake, ask Vice to open a support request for a human review.`,
      );
    }
  }
}

// ---- Accounts: unique usernames, Gmail, passwords, 2-step ----
// Every ViceSunshine account has its OWN username — no two accounts
// can share one (compared trimmed and case-insensitively, so "Vice"
// and "vice" are the same username). Account creation requires a
// valid Google email (Gmail) plus a password typed twice; the
// password is stored only as a salted PBKDF2 hash and is what lets a
// player sign back in on a new device and recover everything saved
// to their account (profile, posts, follows, crews, saves, settings
// all live server-side on the account, keyed by its player key).
function assertGmailEmail(email: string): void {
  const e = email.trim();
  if (!e) {
    throw new Error("Enter your Gmail address — creating an account needs a valid Google email (Gmail).");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw new Error("That email doesn't look complete — check it and try again.");
  }
  if (!/@(gmail\.com|googlemail\.com)$/i.test(e)) {
    throw new Error("ViceSunshine accounts are created with a Google email — enter a Gmail address (ending in @gmail.com). Other email providers aren't accepted for sign-up.");
  }
}

async function assertUsernameAvailable(ctx: Ctx, gamertag: string, selfPlayerKey: string): Promise<void> {
  const db = ctx.db<typeof schema>();
  const norm = gamertag.trim().toLowerCase();
  const all = await db
    .select({ playerKey: schema.profiles.playerKey, gamertag: schema.profiles.gamertag })
    .from(schema.profiles);
  const taken = all.some((p) => p.playerKey !== selfPlayerKey && p.gamertag.trim().toLowerCase() === norm);
  if (taken) {
    throw new Error("That username is already taken — every ViceSunshine username is different, so pick another one.");
  }
}

// One account per Gmail (owner's rule): an email already on another
// account can never be used again — checked live at the sign-up
// email step (checkEmail) and enforced again here at creation and
// whenever Settings changes an email, so no path can duplicate one.
async function assertEmailAvailable(ctx: Ctx, email: string, selfPlayerKey: string): Promise<void> {
  const db = ctx.db<typeof schema>();
  const norm = email.trim().toLowerCase();
  if (!norm) return;
  const all = await db
    .select({ playerKey: schema.profiles.playerKey, email: schema.profiles.email })
    .from(schema.profiles);
  const taken = all.some((p) => p.playerKey !== selfPlayerKey && p.email.trim().toLowerCase() === norm);
  if (taken) {
    throw new Error("That Gmail is already used by another ViceSunshine account — one account per Gmail. Log in with that account instead, or use a different Gmail.");
  }
}

// Phone numbers sign players in too (Gmail OR phone + password), so
// a number can only sit on one account. Numbers compare by digits
// only — spaces, dashes and a leading + don't make a new number.
function phoneDigitsOf(raw: string): string {
  return raw.replace(/\D/g, "");
}
function assertPhoneShape(raw: string): string {
  const digits = phoneDigitsOf(raw);
  if (digits.length < 7 || digits.length > 15) {
    throw new Error("That phone number doesn't look complete — enter it with the area / country code, digits only.");
  }
  return digits;
}
async function assertPhoneAvailable(ctx: Ctx, digits: string, selfPlayerKey: string): Promise<void> {
  if (!digits) return;
  const db = ctx.db<typeof schema>();
  const all = await db
    .select({ playerKey: schema.profiles.playerKey, phone: schema.profiles.phone })
    .from(schema.profiles);
  const taken = all.some((p) => p.playerKey !== selfPlayerKey && phoneDigitsOf(p.phone) === digits);
  if (taken) {
    throw new Error("That phone number is already used by another ViceSunshine account — one account per number. Log in with that account instead.");
  }
}

// ---- Email codes: confirm an email / reset a password ----
// A 6-digit code is generated here, stored ONLY as a SHA-256 hash
// (email_codes), and emailed AUTOMATICALLY to the address by a DIRECT
// Resend API call (server/standalone/email.ts) from the verified
// @vicesunshine.com sender — no one sends anything by hand, and no
// agent task or Gmail connector is involved (this is the standalone
// build; in Muse the same email went through a spawned Gmail-connector
// task). Delivery is built for speed (owner's direction, Nov 20 2026:
// the code must arrive fast, directly, immediately): one direct API
// call, fired the moment the code is issued. This fires in the
// TRN sign-up flow (owner's direction, re-confirmed Nov 20
// 2026: email → CREATE NEW ACCOUNT? → Create New → VERIFY
// YOUR EMAIL with the code → then username and password →
// account created → straight to Profile — the code step is
// never skipped and username/password never come before it):
// pressing Create New issues a "verify" code, verifySignupCode
// checks it and hands back a short-lived signup proof, and
// createAccount requires that proof (or the code itself) so
// the account starts with its email verified. It also fires
// on a Settings confirmation request and on Forgot password
// (a reset code). Codes live 1 minute, one
// live code per email + purpose, 5 wrong guesses kill a code,
// and a fresh code can be requested after 20 seconds (the old
// 60-second wait made a lost first email feel like no code was
// ever coming).
const OFFICIAL_VICESUNSHINE_EMAIL = "officialvicesunshine@gmail.com";
const EMAIL_CODE_TTL_MS = 1 * 60 * 1000;
const EMAIL_CODE_RESEND_MS = 20 * 1000;
// "signup" is not an emailed code: it is the purpose under
// which the hash of a signup proof token is stored (see
// issueSignupProof below).
type EmailCodePurpose = "verify" | "reset" | "login" | "signup";
async function issueEmailCode(ctx: Ctx, email: string, purpose: EmailCodePurpose): Promise<string> {
  const db = ctx.db<typeof schema>();
  const norm = email.trim().toLowerCase();
  await db
    .delete(schema.emailCodes)
    .where(and(eq(schema.emailCodes.email, norm), eq(schema.emailCodes.purpose, purpose)));
  const code = String(100000 + Math.floor(Math.random() * 900000));
  await db.insert(schema.emailCodes).values({
    email: norm,
    purpose,
    codeHash: await sha256Hex(code),
    expiresAt: Date.now() + EMAIL_CODE_TTL_MS,
    attempts: 0,
    createdAt: Date.now(),
  });
  return code;
}
async function emailCodeSentRecently(ctx: Ctx, email: string, purpose: EmailCodePurpose): Promise<boolean> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.emailCodes)
    .where(and(eq(schema.emailCodes.email, email.trim().toLowerCase()), eq(schema.emailCodes.purpose, purpose)));
  const row = rows[0];
  return Boolean(row && Date.now() - row.createdAt < EMAIL_CODE_RESEND_MS);
}
async function deliverEmailCode(_ctx: Ctx, email: string, purpose: "verify" | "reset" | "login", code: string, variant: "standard" | "signup" = "standard"): Promise<void> {
  // Professional branded HTML code emails in ViceSunshine's own
  // identity (owner's direction, Nov 20 2026: the old plain layout
  // "looks so fake" — make it look like a legit company email;
  // then: go further than the screenshot — white VS letters on the
  // gradient, a proper "Welcome to ViceSunshine!" heading, the
  // ViceSunshine wordmark, a premium dark card with a pink-purple
  // gradient border, clean compact code boxes — and NO button
  // or banner under the code: the owner removed the pink-purple
  // "Verify your email" pill (Nov 20 2026) because it read as a
  // confusing fake button; the email is just the code plus the
  // "enter this code in ViceSunshine" text). Email-client-safe
  // build: table layout, inline styles, no external images.
  // DARK-ONLY, like the ViceSunshine theme (owner's direction,
  // Nov 20 2026, after his Gmail screenshot showed the card
  // flipped to a light lavender/white background): the WHOLE
  // email is dark navy — shell #0a0a12, card #12121f, code boxes
  // #1e1e30 with white digits — no light, white or lavender
  // surface anywhere. Gmail's app dark mode had inverted the
  // previous build (white code boxes became black, the dark card
  // became pale lavender) because it only carried CSS background
  // styles and a "dark light" color-scheme. This build defends
  // the dark theme on every layer email clients respect:
  // color-scheme / supported-color-schemes are "only dark",
  // bgcolor attributes sit on the shell, card and code boxes
  // alongside the CSS, and a <style> block re-asserts the dark
  // colours with !important under prefers-color-scheme: dark,
  // Gmail's data-ogsc / data-ogsb dark-mode hooks, and the
  // u + .vs-body Gmail selector. The card keeps its 2px hot
  // pink -> neon purple -> teal gradient border (bgcolor
  // fallback #9b5de5 where gradients are dropped); the VS logo
  // block carries WHITE "VS" letters on the pink-purple
  // gradient; under it the wordmark and a purpose headline
  // ("Welcome to ViceSunshine!" on sign-up). The code appears
  // ONCE, in six compact dark boxes with white digits (42x52px,
  // 26px type, 10px radius, 6px gaps — smaller and neater than
  // the old 58x74px boxes, per the owner; no duplicated code
  // line — the old second copy made Gmail previews read
  // "595732 595732..."). Under the boxes there is NO button or
  // banner, just the line "Enter the code above in ViceSunshine
  // to continue." Then an expiry pill, a never-share
  // security note, and a full footer with the ViceSunshine name,
  // official address and the unofficial-fan disclaimer. A hidden
  // preheader carries the single line "Your verification code
  // is: CODE" so inbox previews read cleanly and Gmail can
  // surface its copy-code chip. Sign-in (welcome back) and reset
  // emails share the same design with their own subject,
  // headline and wording.
  const subject = purpose === "reset"
    ? "ViceSunshine — here is your password reset code!"
    : purpose === "login"
      ? "Welcome back to ViceSunshine! Here is your sign-in code!"
      : "Welcome to ViceSunshine! Here is your registration code!";
  const headline = purpose === "reset"
    ? "Reset your password"
    : purpose === "login"
      ? "Welcome back to ViceSunshine!"
      : variant === "signup"
        ? "Welcome to ViceSunshine!"
        : "Verify your email";
  const codeLabel = purpose === "reset"
    ? "Your password reset code is:"
    : purpose === "login"
      ? "Your sign-in code is:"
      : "Your verification code is:";
  const digits = code.split("");
  const boxes = digits.map((d) => `<td class="vs-box" align="center" valign="middle" bgcolor="#1e1e30" style="width:42px;height:52px;background:#1e1e30;border:1px solid #3d3d5c;border-radius:10px;font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:800;color:#ffffff;">${d}</td>`).join(`<td style="width:6px;font-size:0;line-height:0;">&nbsp;</td>`);
  const intro = purpose === "reset"
    ? "Enter this code in ViceSunshine to set a new password. If you didn't ask for this, ignore this email — your password stays the same."
    : purpose === "login"
      ? "Enter this code in ViceSunshine to finish signing in. If you didn't try to sign in, ignore this email — your account stays as it is."
      : variant === "signup"
        ? "Enter this code in ViceSunshine to verify your email and continue creating your account. If you didn't ask to create a ViceSunshine account, ignore this email."
        : "Enter this code in ViceSunshine to confirm this email address. If you didn't ask for this, ignore this email.";
  const year = new Date().getFullYear();
  const html = [
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="only dark"><meta name="supported-color-schemes" content="only dark"><title>${subject}</title>`,
    // Dark-mode defence: re-assert the dark navy theme with
    // !important wherever a mail app tries to invert it (Gmail
    // app dark mode exposes data-ogsc / data-ogsb hooks and the
    // u + .vs-body selector; Outlook.com uses the same hooks).
    `<style>:root{color-scheme:only dark;supported-color-schemes:only dark}body{margin:0;padding:0;background-color:#0a0a12!important}.vs-bg{background-color:#0a0a12!important}.vs-card{background-color:#12121f!important}.vs-box{background-color:#1e1e30!important;color:#ffffff!important}.vs-pill{background-color:#1b1b2c!important;color:#e8e8f2!important}.vs-white{color:#ffffff!important}.vs-dim{color:#b8b8cc!important}.vs-faint{color:#8e8ea8!important}u + .vs-body{background-color:#0a0a12!important}u + .vs-body .vs-card{background-color:#12121f!important}[data-ogsc] .vs-bg,[data-ogsb] .vs-bg{background-color:#0a0a12!important}[data-ogsc] .vs-card,[data-ogsb] .vs-card{background-color:#12121f!important}[data-ogsc] .vs-box,[data-ogsb] .vs-box{background-color:#1e1e30!important;color:#ffffff!important}[data-ogsc] .vs-white,[data-ogsb] .vs-white{color:#ffffff!important}@media (prefers-color-scheme:dark){.vs-bg{background-color:#0a0a12!important}.vs-card{background-color:#12121f!important}.vs-box{background-color:#1e1e30!important;color:#ffffff!important}.vs-pill{background-color:#1b1b2c!important;color:#e8e8f2!important}.vs-white{color:#ffffff!important}.vs-dim{color:#b8b8cc!important}.vs-faint{color:#8e8ea8!important}}</style></head>`,
    `<body class="vs-body vs-bg" bgcolor="#0a0a12" style="margin:0;padding:0;background:#0a0a12;color-scheme:only dark;">`,
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Your verification code is: ${code} — enter it in ViceSunshine within 1 minute.</div>`,
    `<table class="vs-bg" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0a0a12" style="background:#0a0a12;"><tr><td align="center" bgcolor="#0a0a12" style="padding:36px 16px 40px;">`,
    // Gradient border wrapper: gradient cell padded 2px around the dark card
    `<table role="presentation" width="604" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:604px;"><tr><td bgcolor="#9b5de5" style="background:linear-gradient(135deg,#FF2E88 0%,#9b5de5 55%,#00d9c0 100%);border-radius:22px;padding:2px;">`,
    `<table class="vs-card" role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#12121f" style="width:100%;max-width:600px;background:#12121f;border-radius:20px;overflow:hidden;">`,
    // Header: VS logo (white letters on the gradient) + wordmark
    `<tr><td align="center" style="padding:40px 40px 0;">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="vs-white" align="center" valign="middle" bgcolor="#c13ae0" style="width:88px;height:88px;border-radius:20px;background:linear-gradient(135deg,#FF2E88 0%,#c13ae0 50%,#7c3aed 100%);font-family:Arial,Helvetica,sans-serif;font-size:38px;font-weight:900;letter-spacing:-1px;color:#ffffff;">VS</td></tr></table>`,
    `<p class="vs-white" style="margin:20px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:28px;font-weight:900;letter-spacing:0.2px;color:#ffffff;">Vice<span style="color:#FF2E88;">Sunshine</span></p>`,
    `<p style="margin:6px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:3px;color:#00d9c0;">YOUR GTA VI AGENT</p>`,
    `</td></tr>`,
    // Headline + intro
    `<tr><td align="center" style="padding:32px 44px 0;">`,
    `<p class="vs-white" style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:25px;font-weight:800;color:#ffffff;">${headline}</p>`,
    `<p class="vs-dim" style="margin:12px auto 0;max-width:440px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#b8b8cc;">${intro}</p>`,
    `</td></tr>`,
    // Code boxes
    `<tr><td align="center" style="padding:30px 16px 0;">`,
    `<p class="vs-faint" style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;letter-spacing:2px;color:#8e8ea8;">${codeLabel.toUpperCase()}</p>`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>${boxes}</tr></table>`,
    `</td></tr>`,
    // No button/banner under the code (owner's direction, Nov 20
    // 2026: the pink-purple "Verify your email" pill read as a
    // confusing fake button) — just the code and this line.
    `<tr><td align="center" style="padding:20px 40px 0;">`,
    `<p class="vs-faint" style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#8e8ea8;">Enter the code above in ViceSunshine to continue.</p>`,
    `</td></tr>`,
    // Expiry pill
    `<tr><td align="center" style="padding:22px 40px 0;">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="vs-pill" bgcolor="#1b1b2c" style="background:#1b1b2c;border:1px solid #2e2e44;border-radius:999px;padding:8px 18px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;color:#e8e8f2;">This code expires in 1 minute</td></tr></table>`,
    `</td></tr>`,
    // Security note
    `<tr><td align="center" style="padding:24px 44px 0;">`,
    `<p class="vs-faint" style="margin:0 auto;max-width:440px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#8e8ea8;">Never share this code with anyone. ViceSunshine will never ask you for your code, password or payment details by email.</p>`,
    `</td></tr>`,
    // Divider
    `<tr><td style="padding:32px 40px 0;"><div style="height:1px;background:#26263c;font-size:0;line-height:0;">&nbsp;</div></td></tr>`,
    // Footer
    `<tr><td align="center" style="padding:22px 44px 34px;">`,
    `<p class="vs-white" style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:800;color:#ffffff;">ViceSunshine</p>`,
    `<p class="vs-faint" style="margin:6px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#8e8ea8;">Sent from the official ViceSunshine account: ${OFFICIAL_VICESUNSHINE_EMAIL}<br>You received this email because this address was used on ViceSunshine.</p>`,
    `<p style="margin:14px auto 0;max-width:460px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;color:#63637c;">ViceSunshine is an unofficial fan-made GTA VI community hub. Not affiliated with, endorsed by, or sponsored by Rockstar Games or Take-Two Interactive. Grand Theft Auto and GTA VI are trademarks of Take-Two Interactive.</p>`,
    `<p style="margin:12px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#63637c;">&copy; ${year} ViceSunshine. All rights reserved.</p>`,
    `</td></tr>`,
    `</table>`,
    `</td></tr></table>`,
    `</td></tr></table>`,
    `</body></html>`,
  ].join("");
  const body = [
    `ViceSunshine — Your GTA VI agent`,
    ``,
    `${headline}`,
    ``,
    `Your verification code is: ${code}`,
    ``,
    intro,
    ``,
    `This code expires in 1 minute. Never share it with anyone — ViceSunshine will never ask you for your code, password or payment details by email.`,
    ``,
    `--`,
    `ViceSunshine (unofficial fan-made GTA VI community hub)`,
    `Sent from ${OFFICIAL_VICESUNSHINE_EMAIL}. Not affiliated with Rockstar Games or Take-Two Interactive.`,
  ].join("\n");
  // Automatic delivery: a single DIRECT Resend API call, fired
  // the moment the code is issued — no agent task, no Gmail
  // handoff, no manual step. The player is standing on the code
  // screen, so this awaits the send: if Resend rejects it (or
  // RESEND_API_KEY is not configured) the error propagates and
  // the code request fails loudly instead of pretending the
  // email was sent. See server/standalone/email.ts.
  await sendCodeEmail({ to: email, subject, html, text: body });
}
// Checks a code the player typed. Returns true (and consumes the
// code) only on an exact, unexpired match.
async function consumeEmailCode(ctx: Ctx, email: string, purpose: EmailCodePurpose, rawCode: string): Promise<boolean> {
  const db = ctx.db<typeof schema>();
  const norm = email.trim().toLowerCase();
  const rows = await db
    .select()
    .from(schema.emailCodes)
    .where(and(eq(schema.emailCodes.email, norm), eq(schema.emailCodes.purpose, purpose)));
  const row = rows[0];
  if (!row) return false;
  if (Date.now() > row.expiresAt || row.attempts >= 5) {
    await db.delete(schema.emailCodes).where(eq(schema.emailCodes.id, row.id));
    return false;
  }
  const hash = await sha256Hex(rawCode.trim());
  if (hash !== row.codeHash) {
    await db
      .update(schema.emailCodes)
      .set({ attempts: row.attempts + 1 })
      .where(eq(schema.emailCodes.id, row.id));
    return false;
  }
  await db.delete(schema.emailCodes).where(eq(schema.emailCodes.id, row.id));
  return true;
}

// Checks a code WITHOUT consuming it (owner's two-step reset:
// the code step checks the digits and moves to the new-password
// step; the code is only consumed when the password is actually
// reset). Wrong guesses still count toward the 5-attempt limit,
// and expired / exhausted codes are deleted exactly as in
// consumeEmailCode.
async function peekEmailCode(ctx: Ctx, email: string, purpose: EmailCodePurpose, rawCode: string): Promise<boolean> {
  const db = ctx.db<typeof schema>();
  const norm = email.trim().toLowerCase();
  const rows = await db
    .select()
    .from(schema.emailCodes)
    .where(and(eq(schema.emailCodes.email, norm), eq(schema.emailCodes.purpose, purpose)));
  const row = rows[0];
  if (!row) return false;
  if (Date.now() > row.expiresAt || row.attempts >= 5) {
    await db.delete(schema.emailCodes).where(eq(schema.emailCodes.id, row.id));
    return false;
  }
  const hash = await sha256Hex(rawCode.trim());
  if (hash !== row.codeHash) {
    await db
      .update(schema.emailCodes)
      .set({ attempts: row.attempts + 1 })
      .where(eq(schema.emailCodes.id, row.id));
    return false;
  }
  return true;
}

// Signup proof (TRN flow): the emailed "verify" code itself
// lives only 1 minute — long enough to type it on the VERIFY
// YOUR EMAIL screen, but not long enough to then choose a
// username and a password. So verifySignupCode CONSUMES the
// code the moment it is entered correctly and issues this
// proof instead: a random token whose SHA-256 hash is stored
// in email_codes under purpose "signup", living 15 minutes —
// just long enough to finish the username and password steps.
// createAccount consumes the proof and starts the account
// with its email verified. The token is never emailed and
// never shown; it only travels from verifySignupCode's
// response to createAccount's request on the same device.
const SIGNUP_PROOF_TTL_MS = 15 * 60 * 1000;
async function issueSignupProof(ctx: Ctx, email: string): Promise<string> {
  const db = ctx.db<typeof schema>();
  const norm = email.trim().toLowerCase();
  await db
    .delete(schema.emailCodes)
    .where(and(eq(schema.emailCodes.email, norm), eq(schema.emailCodes.purpose, "signup")));
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db.insert(schema.emailCodes).values({
    email: norm,
    purpose: "signup",
    codeHash: await sha256Hex(token),
    expiresAt: Date.now() + SIGNUP_PROOF_TTL_MS,
    attempts: 0,
    createdAt: Date.now(),
  });
  return token;
}

function assertPasswordPair(password: string, confirmPassword: string): void {
  if (password.length < 8) {
    throw new Error("Your password needs at least 8 characters — a longer mix of letters, numbers and symbols is stronger.");
  }
  if (password.length > 72) {
    throw new Error("Your password is too long — keep it to 72 characters or fewer.");
  }
  if (password !== confirmPassword) {
    throw new Error("Your passwords don't match — type the same password in both boxes.");
  }
}

function b64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
function b64Decode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt, iterations: 100_000, hash: "SHA-256" },
    key,
    256,
  );
  return `pbkdf2$100000$${b64Encode(salt)}$${b64Encode(new Uint8Array(bits))}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1 || iterations > 1_000_000) return false;
  const salt = b64Decode(parts[2] ?? "");
  const expected = b64Decode(parts[3] ?? "");
  if (expected.length === 0) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt, iterations, hash: "SHA-256" },
    key,
    expected.length * 8,
  );
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  return diff === 0;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Authenticator-app 2-step verification (TOTP, RFC 6238 — the same
// codes Google Authenticator / Authy generate every 30 seconds).
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function totpCodeForCounter(secret: string, counter: number): Promise<string> {
  const keyBytes = base32Decode(secret);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 0x1_0000_0000));
  view.setUint32(4, counter >>> 0);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = (sig[19] ?? 0) & 0xf;
  const binary =
    ((sig[offset] ?? 0) & 0x7f) * 0x1000000 +
    ((sig[offset + 1] ?? 0) & 0xff) * 0x10000 +
    ((sig[offset + 2] ?? 0) & 0xff) * 0x100 +
    ((sig[offset + 3] ?? 0) & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

async function verifyTotpCode(secret: string, code: string): Promise<boolean> {
  const clean = code.replace(/\D/g, "");
  if (clean.length !== 6 || !secret) return false;
  const counter = Math.floor(Date.now() / 30_000);
  for (const delta of [-1, 0, 1]) {
    if ((await totpCodeForCounter(secret, counter + delta)) === clean) return true;
  }
  return false;
}

function newBackupCodes(): string[] {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const raw = [...bytes].map((b) => chars[b % chars.length] ?? "A").join("");
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

const accountCreatedResponse = z.object({ ok: z.literal(true), gamertag: z.string() });
const seedBotsResponse = z.object({
  ok: z.literal(true),
  alreadySeeded: z.boolean(),
  profilesCreated: z.number(),
  crewsCreated: z.number(),
  postsCreated: z.number(),
  commentsCreated: z.number(),
  likesCreated: z.number(),
  followsCreated: z.number(),
});
const signInResponse = z.object({
  ok: z.boolean(),
  needsTwoFactor: z.boolean(),
  needsEmailCode: z.boolean(),
  playerKey: z.string(),
  gamertag: z.string(),
  message: z.string(),
});
const twoFactorSetupResponse = z.object({ secret: z.string(), otpauthUri: z.string() });
const twoFactorConfirmResponse = z.object({ ok: z.literal(true), backupCodes: z.array(z.string()) });

function screenMediaUrl(url: string): string | null {
  if (!url) return null;
  if (/\.(zip|rar|7z|apk|exe|dmg|iso|torrent)(\?|#|$)/i.test(url)) {
    return "direct file-download links are not allowed — share videos from YouTube or TikTok instead";
  }
  if (/(mega\.nz|mediafire\.com|anonfiles|zippyshare)/i.test(url)) {
    return "file-host download links are not allowed — share videos from YouTube or TikTok instead";
  }
  return null;
}

// ---- Owner access ----
// The Owner is the first / creator account: the earliest profile
// ever created in ViceSunshine. The owner signs in with that normal
// account on their own device — there is no separate login or
// secret site — and only that account can call the owner actions
// or see the Owner Dashboard.
async function ownerProfileRow(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.profiles).orderBy(schema.profiles.id);
  return rows[0] ?? null;
}

async function assertOwner(ctx: Ctx, playerKey: string) {
  const owner = await ownerProfileRow(ctx);
  if (!owner || owner.playerKey !== playerKey) {
    throw new Error("Owner access only — this area is restricted to the ViceSunshine owner account.");
  }
  return owner;
}

// One Feed post as the Instagram-style profile grids show it: the
// media resolved exactly like the Feed (YouTube becomes the in-app
// player, an editorial news picture becomes the image), with real
// like / comment / view counts counted from their own tables.
const profilePostItem = z.object({
  id: z.number(),
  author: z.string(),
  authorKey: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  mediaUrl: z.string(),
  mediaType: z.string(),
  embedUrl: z.string(),
  videoId: z.string(),
  sourceName: z.string(),
  sourceUrl: z.string(),
  likes: z.number(),
  likedByMe: z.boolean(),
  commentCount: z.number(),
  views: z.number(),
  shares: z.number(),
  mine: z.boolean(),
  authorAvatarUrl: z.string(),
  createdAt: z.string(),
});
type ProfilePostRow = typeof schema.feedPosts.$inferSelect;
async function profilePostItems(ctx: Ctx, rows: ProfilePostRow[], viewerKey: string): Promise<z.infer<typeof profilePostItem>[]> {
  const db = ctx.db<typeof schema>();
  const reactions = await db.select().from(schema.feedReactions);
  const comments = await db.select().from(schema.feedComments);
  const viewRows = await db.select().from(schema.feedViews);
  const profileMap = await profilesByKey(ctx);
  const artUrls = await avatarArtUrls(ctx);
  const customArt = await customAvatarUrls(ctx);
  const imageUrlOf = new Map<number, string>();
  for (const r of rows) {
    if (r.imageBlobKey) {
      try { imageUrlOf.set(r.id, await ctx.blobs.getUrl(r.imageBlobKey)); } catch { /* picture missing — post renders without it */ }
    }
  }
  return rows.map((r) => {
    const imgUrl = imageUrlOf.get(r.id) ?? "";
    const base = feedMediaOf(r.mediaUrl);
    const media = base.mediaType === "none" && imgUrl ? { mediaType: "image", embedUrl: "", videoId: "" } : base;
    return {
      id: r.id,
      author: r.author,
      authorKey: r.authorKey,
      kind: r.kind,
      title: r.title,
      body: media.mediaType === "youtube" ? stripVideoUrlsFromBody(r.body, r.mediaUrl) : r.body,
      mediaUrl: media.mediaType === "image" && imgUrl ? imgUrl : r.mediaUrl,
      ...media,
      sourceName: r.sourceName,
      sourceUrl: r.sourceUrl,
      likes: reactions.filter((x) => x.postId === r.id).length,
      likedByMe: reactions.some((x) => x.postId === r.id && x.playerKey === viewerKey),
      commentCount: comments.filter((x) => x.postId === r.id).length,
      views: viewRows.filter((x) => x.postId === r.id).length,
      shares: r.shares,
      mine: r.authorKey === viewerKey,
      authorAvatarUrl: pickAvatar(artUrls, customArt, profileMap.get(r.authorKey)),
      createdAt: r.createdAt.toISOString(),
    };
  });
}

// One crew at a time (owner's rule): a player can only be in ONE
// crew — and therefore one crew chat — at a time. Joining or
// founding another crew is refused until they leave the first.
async function assertNotInAnotherCrew(ctx: Ctx, playerKey: string, exceptClanId = 0, applicantName = ""): Promise<void> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.clanMembers).where(eq(schema.clanMembers.playerKey, playerKey));
  const other = rows.find((r) => r.clanId !== exceptClanId);
  if (!other) return;
  const clans = await db.select().from(schema.clans);
  const name = clans.find((c) => c.id === other.clanId)?.name ?? "another crew";
  if (applicantName) {
    throw new Error(`${applicantName} is already in ${name} — a player can only be in one crew (and one crew chat) at a time, so this application can't be approved until they leave ${name}.`);
  }
  throw new Error(`You're already in ${name} — you can only be in one crew (and one crew chat) at a time. Leave ${name} first to join another crew.`);
}

// Crew chats are AUTOMATIC (owner's direction): every crew has a
// chat, created the moment the crew exists, and its membership
// always mirrors the crew's member list — joining a crew puts you
// in its chat, leaving the crew takes you out, and the crew Leader
// owns it. This runs on every conversation-list read, so crews
// that already exist (and crews made before this feature) get
// their chat on the next Messages open, with no manual step.
async function ensureCrewChats(ctx: Ctx, playerKey: string): Promise<void> {
  const db = ctx.db<typeof schema>();
  const myMemberships = await db.select().from(schema.clanMembers).where(eq(schema.clanMembers.playerKey, playerKey));
  if (myMemberships.length === 0) return;
  const clanIds = [...new Set(myMemberships.map((m) => m.clanId))];
  const clans = await db.select().from(schema.clans);
  const clanById = new Map(clans.map((c) => [c.id, c]));
  const allMembers = await db.select().from(schema.clanMembers);
  const groups = await db.select().from(schema.chatGroups);
  for (const clanId of clanIds) {
    const clan = clanById.get(clanId);
    if (!clan) continue;
    const members = allMembers.filter((m) => m.clanId === clanId);
    const leader = members.find((m) => m.role === "Leader") ?? members[0];
    const existing = groups.find((x) => x.kind === "crew" && x.clanId === clanId);
    if (!existing) {
      const res = await db.insert(schema.chatGroups).values({
        kind: "crew", name: clan.name, clanId, ownerKey: leader?.playerKey ?? playerKey,
      }).returning({ id: schema.chatGroups.id });
      const gid = res[0]?.id ?? 0;
      if (gid > 0) {
        // The Leader goes in first — they created the crew, so they
        // are the crew chat's first member (and its owner).
        const ordered = [...members].sort((a, b) => (a.role === "Leader" ? 0 : 1) - (b.role === "Leader" ? 0 : 1) || a.id - b.id);
        for (const m of ordered) {
          await db.insert(schema.chatGroupMembers).values({ groupId: gid, playerKey: m.playerKey });
        }
      }
      continue;
    }
    if (existing.name !== clan.name || (leader && existing.ownerKey !== leader.playerKey)) {
      await db.update(schema.chatGroups)
        .set({ name: clan.name, ownerKey: leader?.playerKey ?? existing.ownerKey })
        .where(eq(schema.chatGroups.id, existing.id));
    }
    const rows = await db.select().from(schema.chatGroupMembers).where(eq(schema.chatGroupMembers.groupId, existing.id));
    const have = new Set(rows.map((r) => r.playerKey));
    const want = new Set(members.map((m) => m.playerKey));
    const orderedMembers = [...members].sort((a, b) => (a.role === "Leader" ? 0 : 1) - (b.role === "Leader" ? 0 : 1) || a.id - b.id);
    for (const m of orderedMembers) {
      if (!have.has(m.playerKey)) await db.insert(schema.chatGroupMembers).values({ groupId: existing.id, playerKey: m.playerKey });
    }
    for (const r of rows) {
      if (!want.has(r.playerKey)) await db.delete(schema.chatGroupMembers).where(eq(schema.chatGroupMembers.id, r.id));
    }
  }
}

// Event chats are AUTOMATIC too (owner's direction): every
// Community Event gets a chat in Messages (under the Crews &
// Events category). Everyone who RSVPs Going is in it, plus the
// host — and the host (the hosting crew's Leader) owns it, so the
// leader stays in control: they can mute members, and removing
// someone from the event removes them from the chat as well.
// Membership re-syncs on every Messages read, exactly like crew
// chats, so RSVP changes land on their own.
async function ensureEventChats(ctx: Ctx, playerKey: string): Promise<void> {
  const db = ctx.db<typeof schema>();
  const profs = await db.select().from(schema.profiles);
  const me = profs.find((x) => x.playerKey === playerKey);
  if (!me) return;
  const myTag = me.gamertag.toLowerCase();
  const allRsvps = await db.select().from(schema.rsvps);
  const events = await db.select().from(schema.events);
  const eventById = new Map(events.map((e) => [e.id, e]));
  const myEventIds = new Set<number>();
  for (const r of allRsvps) {
    if (r.playerKey === playerKey && r.status === "Going") myEventIds.add(r.eventId);
  }
  for (const e of events) {
    if (e.host.toLowerCase() === myTag) myEventIds.add(e.id);
  }
  if (myEventIds.size === 0) return;
  const groups = await db.select().from(schema.chatGroups);
  for (const eventId of myEventIds) {
    const ev = eventById.get(eventId);
    if (!ev) continue;
    const hostKey = profs.find((x) => x.gamertag.toLowerCase() === ev.host.toLowerCase())?.playerKey ?? "";
    const goingKeys = allRsvps.filter((r) => r.eventId === eventId && r.status === "Going").map((r) => r.playerKey);
    const memberKeys = [...new Set([...goingKeys, ...(hostKey ? [hostKey] : [])])];
    let g = groups.find((x) => x.kind === "event" && x.eventId === eventId);
    if (!g) {
      const res = await db
        .insert(schema.chatGroups)
        .values({ name: ev.title, kind: "event", clanId: 0, eventId, ownerKey: hostKey })
        .returning({ id: schema.chatGroups.id });
      const gid = res[0]?.id ?? 0;
      if (!gid) continue;
      g = { id: gid, name: ev.title, kind: "event", clanId: 0, eventId, ownerKey: hostKey, createdAt: new Date() };
      groups.push(g);
    } else if (g.name !== ev.title) {
      await db.update(schema.chatGroups).set({ name: ev.title }).where(eq(schema.chatGroups.id, g.id));
    }
    const members = await db.select().from(schema.chatGroupMembers).where(eq(schema.chatGroupMembers.groupId, g.id));
    const have = new Set(members.map((m) => m.playerKey));
    for (const k of memberKeys) {
      if (!have.has(k)) await db.insert(schema.chatGroupMembers).values({ groupId: g.id, playerKey: k });
    }
    for (const m of members) {
      if (!memberKeys.includes(m.playerKey)) {
        await db.delete(schema.chatGroupMembers).where(eq(schema.chatGroupMembers.id, m.id));
      }
    }
  }
}

export const Actions = {
  getHub: defineAction({
    description: "Returns hub-wide stats and the last news refresh time.",
    request: z.object({}),
    response: z.object({
      newsCount: z.number(),
      patchCount: z.number(),
      bugCount: z.number(),
      clanCount: z.number(),
      memberCount: z.number(),
      eventCount: z.number(),
      lastRefreshedAt: z.string(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const [n, p, b, c, m, e] = await Promise.all([
        db.select().from(schema.news),
        db.select().from(schema.patches),
        db.select().from(schema.bugs),
        db.select().from(schema.clans),
        db.select().from(schema.clanMembers),
        db.select().from(schema.events),
      ]);
      return {
        newsCount: n.length,
        patchCount: p.length,
        bugCount: b.length,
        clanCount: c.length,
        memberCount: m.length,
        eventCount: e.length,
        lastRefreshedAt: await getMeta(ctx, "last_refreshed_at"),
      };
    },
  }),

  getDailyStats: defineAction({
    description: "Daily tracker counts for the Home stats row: how many news posts, updates, bug reports and events were posted today (counted from the viewer's local midnight, passed in as dayStart) next to the all-time totals — the row updates every 24 hours, and each tile opens that category's full history.",
    request: z.object({
      dayStart: z.string().max(40).default(""),
    }),
    response: z.object({
      newsToday: z.number(),
      updatesToday: z.number(),
      bugsToday: z.number(),
      eventsToday: z.number(),
      newsTotal: z.number(),
      updatesTotal: z.number(),
      bugsTotal: z.number(),
      eventsTotal: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const parsed = args.dayStart ? new Date(args.dayStart) : null;
      const start = parsed && !Number.isNaN(parsed.getTime())
        ? parsed
        : new Date(new Date().setUTCHours(0, 0, 0, 0));
      const since = (rows: { createdAt: Date }[]) => rows.filter((r) => r.createdAt >= start).length;
      const [news, patches, bugs, events] = await Promise.all([
        db.select().from(schema.news),
        db.select().from(schema.patches),
        db.select().from(schema.bugs),
        db.select().from(schema.events),
      ]);
      return {
        newsToday: since(news),
        updatesToday: since(patches),
        bugsToday: since(bugs),
        eventsToday: since(events),
        newsTotal: news.length,
        updatesTotal: patches.length,
        bugsTotal: bugs.length,
        eventsTotal: events.length,
      };
    },
  }),

  getServerStatus: defineAction({
    description: "Live server status for the Home page block: whether the server answered (Online), when the current server process started (uptime), how many players are online right now by the app's own presence rule plus the total player count, and the real last-run time of each automatic pipeline — news, feed, database, moderation — from the meta stamp that pipeline writes when it runs (empty string until its first run).",
    request: z.object({}),
    response: serverStatusResponse,
    handler: async (ctx): Promise<z.infer<typeof serverStatusResponse>> => {
      const db = ctx.db<typeof schema>();
      const profs = await db.select().from(schema.profiles);
      const nowMs = Date.now();
      // The same rule effectivePresence applies for other players:
      // a chosen status of Ghost / Offline never counts, and anyone
      // inactive for over 5 minutes no longer counts as online.
      const playersOnline = profs.filter((p) => {
        const chosen = p.presence || "Online";
        if (chosen === "Ghost" || chosen === "Offline") return false;
        const seen = p.lastSeen ? p.lastSeen.getTime() : 0;
        return seen > 0 && nowMs - seen <= PRESENCE_STALE_MS;
      }).length;
      const [news, feed, database, moderation] = await Promise.all([
        getMeta(ctx, "last_refreshed_at"),
        getMeta(ctx, "last_feed_media_refresh_at"),
        getMeta(ctx, "last_db_sync_at"),
        getMeta(ctx, "last_automation_sweep_at"),
      ]);
      return {
        online: true,
        serverNow: new Date(nowMs).toISOString(),
        serverStartedAt: SERVER_PROCESS_STARTED_AT,
        playersOnline,
        playersTotal: profs.length,
        pipelines: { news, feed, database, moderation },
      };
    },
  }),

  getRockstarStatus: defineAction({
    description: "Returns the latest stored check of Rockstar's official service status page: when it was checked, the overall state (operational / issues / down / unknown), and the per-service lines exactly as read. A check that could not read the page (overall 'unknown') never becomes the displayed status when an earlier check DID read it: the surfaces fall back to the most recent readable check, with that check's own time, so the box always shows a real Online / Maintenance / Offline state. 'unknown' is returned only when no check has ever been read — the surfaces then show a checking state and run a fresh check, never a guessed status.",
    request: z.object({}),
    response: rockstarStatusResponse,
    handler: async (ctx): Promise<z.infer<typeof rockstarStatusResponse>> => {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.rockstarStatusChecks).orderBy(desc(schema.rockstarStatusChecks.id));
      const row = rows.find((r) => r.overall !== "unknown") ?? rows[0];
      if (!row) return { checkedAt: null, overall: "unknown", services: [], sourceUrl: ROCKSTAR_STATUS_URL };
      let services: { name: string; status: string }[] = [];
      try {
        const parsed = JSON.parse(row.servicesJson) as unknown;
        if (Array.isArray(parsed)) {
          services = parsed
            .filter((s): s is { name: string; status: string } => !!s && typeof s === "object" && typeof (s as { name?: unknown }).name === "string" && typeof (s as { status?: unknown }).status === "string")
            .slice(0, 24);
        }
      } catch {
        services = [];
      }
      return { checkedAt: row.createdAt.toISOString(), overall: row.overall, services, sourceUrl: ROCKSTAR_STATUS_URL };
    },
  }),

  saveRockstarStatusCheck: defineAction({
    description: "Stores one Rockstar service status check read from Rockstar's official status page. Called by the checker task that refreshRockstarStatus starts — the task opens the page itself and reports only what the page says; this action validates and stores it. overall is operational / issues / down / unknown (unknown when the page could not be read).",
    request: z.object({
      overall: z.enum(["operational", "issues", "down", "unknown"]),
      services: z.array(z.object({ name: z.string().min(1).max(80), status: z.string().min(1).max(40) })).max(24),
    }),
    response: z.object({ ok: z.literal(true), checkedAt: z.string() }),
    handler: async (ctx, args): Promise<{ ok: true; checkedAt: string }> => {
      const db = ctx.db<typeof schema>();
      const row = await db
        .insert(schema.rockstarStatusChecks)
        .values({ overall: args.overall, servicesJson: JSON.stringify(args.services), sourceUrl: ROCKSTAR_STATUS_URL })
        .returning();
      ctx.invalidateQueries();
      return { ok: true, checkedAt: (row[0]?.createdAt ?? new Date()).toISOString() };
    },
  }),

  refreshRockstarStatus: defineAction({
    description: "Starts a fresh check of Rockstar's official service status page: a background task opens the page itself, reads the overall state and per-service lines, and stores them via saveRockstarStatusCheck. (The server search index does not reliably surface that page, and only Rockstar's own page may drive the status — a third-party summary must never mark Rockstar up or down.) Live tracking: the schedule runs this every few minutes and open pages call it on open, on return and when the status box is pressed — it skips starting a new check when one already ran in the last 60 seconds or one was already requested in the last 3 minutes and is still landing, so frequent calls never pile up duplicate checker tasks.",
    request: z.object({}),
    response: z.object({ checked: z.boolean(), overall: z.string(), checkedAt: z.string() }),
    handler: async (ctx): Promise<{ checked: boolean; overall: string; checkedAt: string }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.rockstarStatusChecks).orderBy(desc(schema.rockstarStatusChecks.id));
      const latest = rows[0];
      if (latest && Date.now() - latest.createdAt.getTime() < 60 * 1000) {
        return { checked: false, overall: latest.overall, checkedAt: latest.createdAt.toISOString() };
      }
      // A checker task takes a while to open Rockstar's page and
      // store its result; without this requested-at stamp, every
      // open page in that window would spawn another checker for
      // the same check. One request covers everyone for 3 minutes.
      const requestedAt = await getMeta(ctx, "rockstar_check_requested_at");
      const requestedMs = requestedAt ? new Date(requestedAt).getTime() : 0;
      if (requestedMs && Date.now() - requestedMs < 3 * 60 * 1000 && (!latest || latest.createdAt.getTime() < requestedMs)) {
        return { checked: false, overall: latest?.overall ?? "unknown", checkedAt: latest ? latest.createdAt.toISOString() : new Date(requestedMs).toISOString() };
      }
      await setMeta(ctx, "rockstar_check_requested_at", new Date().toISOString());
      // Standalone note: the Muse build spawned an agent task to read
      // Rockstar's page and call saveRockstarStatusCheck. There is no
      // agent in this build, so ctx.agent.spawnTask returns ok:false
      // and this handler reports checked:false instead of pretending
      // a check happened. The last real status stays on screen.
      const spawned = await ctx.agent.spawnTask(
        [
          "Check Rockstar's official service status page and store what it says in ViceSunshine.",
          "",
          `1. Open this exact page in the browser: ${ROCKSTAR_STATUS_URL} — it is Rockstar Games' own service status page ("Service Status - Rockstar Games Customer Support"). The service list loads after the page shell, so wait until the service / platform lines are actually visible; if they are not visible yet, wait a few seconds and open the page once more before deciding it cannot be read. Read the overall banner and every service / platform line on it (Grand Theft Auto Online per platform, Red Dead Online per platform, Online Services such as Authentication, Rockstar Games Launcher and Store, and any others listed).`,
          "2. Call the ViceSunshine action saveRockstarStatusCheck with:",
          "   - overall: \"operational\" if every listed service is operational; \"issues\" if any service is limited, degraded or under maintenance but none is down; \"down\" if any service is down, in outage or unavailable; \"unknown\" if the page could not be opened or read.",
          "   - services: one entry per service or platform line the page lists, named as the page names it (for example \"Grand Theft Auto Online — PlayStation 5\"), with status \"Operational\", \"Limited\", \"Down\" or \"Unknown\" matching the page's own wording for that line.",
          "Report ONLY what Rockstar's own page says. Do not use any other website, search result or prior knowledge for the status, and do not guess a state the page does not show.",
        ].join("\n"),
      );
      return {
        checked: spawned.ok,
        overall: latest?.overall ?? "unknown",
        checkedAt: latest ? latest.createdAt.toISOString() : new Date().toISOString(),
      };
    },
  }),

  setFeedSave: defineAction({
    description: "Records (or removes) a player's save of a Feed post server-side, so the post author's profile analytics can count real saves received. Runs alongside the saver's on-device Saved list, which is unchanged. Saving your own post is ignored.",
    request: z.object({
      playerKey: z.string().min(1).max(200),
      postId: z.number().int().positive(),
      saved: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      const post = (await db.select().from(schema.feedPosts).where(eq(schema.feedPosts.id, args.postId)))[0];
      if (!post || post.authorKey === args.playerKey) return { ok: true };
      const existing = await db
        .select()
        .from(schema.feedSaves)
        .where(and(eq(schema.feedSaves.postId, args.postId), eq(schema.feedSaves.playerKey, args.playerKey)));
      if (args.saved && existing.length === 0) {
        await db.insert(schema.feedSaves).values({ postId: args.postId, playerKey: args.playerKey });
      }
      if (!args.saved && existing.length > 0) {
        await db.delete(schema.feedSaves).where(eq(schema.feedSaves.id, existing[0]!.id));
      }
      return { ok: true };
    },
  }),

  getProfileAnalytics: defineAction({
    description: "Returns one player's real profile analytics: all-time totals (followers, following, posts, likes / views / comments / saves / reposts received on their own posts, excluding their own actions). Direction and summing are the owner's rule: every interaction metric counts ONLY what other people did on THIS player's profile and posts — never what this player did on other people's posts — and each number is one whole-profile total summed across ALL of the player's posts (two videos' views add into a single Views total), never a per-post figure. a 14-day cumulative daily series per metric, a long cumulative daily history (from the day the account was created through today, capped at 3 years — tracking starts on day one, nothing is backfilled from before the account existed) behind the growth graph's 1Y / 2Y / 3Y / YTD / All range picker, a last-7-days vs previous-7-days comparison with delta and % change per metric, per-month counts for every month from the history start through the current month, and the most recent individual growth events for the Activity list. Followers and Following are signed series built from the follow event log, so they go down on unfollows as well as up. Everything is counted from stored rows — nothing is estimated or invented. With no profile yet it returns the same shapes zero-filled, so the analytics display is always on screen, ready to grow.",
    request: z.object({ playerKey: z.string().min(1).max(200) }),
    response: profileAnalyticsResponse,
    handler: async (ctx, args): Promise<z.infer<typeof profileAnalyticsResponse>> => {
      const db = ctx.db<typeof schema>();
      const zeroTotals = { followers: 0, following: 0, posts: 0, likes: 0, views: 0, comments: 0, saves: 0, reposts: 0 };
      const DAY_MS = 24 * 60 * 60 * 1000;
      const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
      const zeroDays: z.infer<typeof profileAnalyticsResponse>["days"] = [];
      for (let i = 13; i >= 0; i--) {
        zeroDays.push({
          day: new Date(todayStart - i * DAY_MS).toISOString().slice(0, 10),
          followers: 0, following: 0, posts: 0, likes: 0, views: 0, comments: 0, saves: 0, reposts: 0,
        });
      }
      // Zero-filled long history for the range picker: January 1
      // of the current year through today, all zeros.
      const zeroHistory: z.infer<typeof profileAnalyticsResponse>["history"] = [];
      const jan1Start = Date.UTC(new Date().getUTCFullYear(), 0, 1);
      for (let tms = jan1Start; tms <= todayStart; tms += DAY_MS) {
        zeroHistory.push({
          day: new Date(tms).toISOString().slice(0, 10),
          followers: 0, following: 0, posts: 0, likes: 0, views: 0, comments: 0, saves: 0, reposts: 0,
        });
      }
      const zeroMonths: z.infer<typeof profileAnalyticsResponse>["months"] = analyticsMonthWindows(jan1Start).map((w) => ({
        key: w.key, label: w.label,
        followers: 0, following: 0, posts: 0, likes: 0, views: 0, comments: 0, saves: 0, reposts: 0,
      }));
      const zeroCompare: z.infer<typeof profileAnalyticsResponse>["compare"] = ["followers", "following", "posts", "likes", "views", "comments", "saves", "reposts"].map((metric) => ({
        metric, current: 0, previous: 0, delta: 0, pct: null,
      }));
      const me = (await db.select().from(schema.profiles).where(eq(schema.profiles.playerKey, args.playerKey)))[0];
      if (!me) {
        return { hasProfile: false, gamertag: "", totals: zeroTotals, days: zeroDays, history: zeroHistory, compare: zeroCompare, months: zeroMonths, recent: [] };
      }
      const myPosts = await db.select().from(schema.feedPosts).where(eq(schema.feedPosts.authorKey, args.playerKey));
      const myPostIds = new Set(myPosts.map((p) => p.id));
      const [followRows, reactionRows, viewRows, commentRows, saveRows, repostRows, followEventRows] = await Promise.all([
        db.select().from(schema.profileFollows),
        db.select().from(schema.feedReactions),
        db.select().from(schema.feedViews),
        db.select().from(schema.feedComments),
        db.select().from(schema.feedSaves),
        db.select().from(schema.feedReposts),
        db.select().from(schema.followEvents),
      ]);
      const t = (d: Date | null) => (d ? d.getTime() : 0);
      // Event timestamps per metric — "received" events only: other
      // people's actions on my posts; my own likes/views/comments on
      // my own posts never count.
      const events: Record<"followers" | "following" | "posts" | "likes" | "views" | "comments" | "saves" | "reposts", number[]> = {
        followers: followRows.filter((f) => f.followingKey === args.playerKey).map((f) => t(f.createdAt)),
        following: followRows.filter((f) => f.followerKey === args.playerKey).map((f) => t(f.createdAt)),
        posts: myPosts.map((p) => t(p.createdAt)),
        likes: reactionRows.filter((r) => myPostIds.has(r.postId) && r.playerKey !== args.playerKey).map((r) => t(r.createdAt)),
        views: viewRows.filter((v) => myPostIds.has(v.postId) && v.playerKey !== args.playerKey).map((v) => t(v.createdAt)),
        comments: commentRows.filter((c) => myPostIds.has(c.postId) && c.authorKey !== args.playerKey).map((c) => t(c.createdAt)),
        saves: saveRows.filter((s) => myPostIds.has(s.postId) && s.playerKey !== args.playerKey).map((s) => t(s.createdAt)),
        reposts: repostRows.filter((r) => myPostIds.has(r.postId) && r.playerKey !== args.playerKey).map((r) => t(r.createdAt)),
      };
      const followingTotal = events.following.length;
      const totals = {
        followers: events.followers.length,
        following: followingTotal,
        posts: events.posts.length,
        likes: events.likes.length,
        views: events.views.length,
        comments: events.comments.length,
        saves: events.saves.length,
        reposts: events.reposts.length,
      };
      const nowMs = Date.now();
      const metricKeys = ["followers", "following", "posts", "likes", "views", "comments", "saves", "reposts"] as const;
      // Signed follow deltas (+1 follow, −1 unfollow) from the follow
      // event log, so the Followers / Following lines can go DOWN
      // when someone unfollows — the current follow rows alone can
      // only ever show growth. Each series is built forward from an
      // opening balance (today's true total minus the net of every
      // logged delta), so the line always ends exactly on the real
      // current count, and follows made before the log existed stay
      // counted at their level.
      const signedDeltas: Record<"followers" | "following", { ts: number; delta: number }[]> = {
        followers: followEventRows.filter((e) => e.followingKey === args.playerKey).map((e) => ({ ts: t(e.createdAt), delta: e.action === "unfollow" ? -1 : 1 })),
        following: followEventRows.filter((e) => e.followerKey === args.playerKey).map((e) => ({ ts: t(e.createdAt), delta: e.action === "unfollow" ? -1 : 1 })),
      };
      const makeSignedSeries = (k: "followers" | "following") => {
        const sorted = signedDeltas[k].filter((d) => d.ts > 0).sort((a, b) => a.ts - b.ts);
        const prefix: number[] = [0];
        for (const d of sorted) prefix.push((prefix[prefix.length - 1] ?? 0) + d.delta);
        const net = prefix[prefix.length - 1] ?? 0;
        const baseline = Math.max(0, (k === "followers" ? totals.followers : totals.following) - net);
        const valueAt = (endMs: number): number => {
          let lo = 0;
          let hi = sorted.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if ((sorted[mid]?.ts ?? Infinity) < endMs) lo = mid + 1;
            else hi = mid;
          }
          return baseline + (prefix[lo] ?? 0);
        };
        return { valueAt, netBetween: (startMs: number, endMs: number) => valueAt(endMs) - valueAt(startMs) };
      };
      const followersSeries = makeSignedSeries("followers");
      const followingSeries = makeSignedSeries("following");
      const signedFor = (k: (typeof metricKeys)[number]) => (k === "followers" ? followersSeries : k === "following" ? followingSeries : null);
      // Long cumulative daily history for the range picker: from
      // the day the ACCOUNT WAS CREATED through today (capped at
      // 3 years, for the 1Y / 2Y / 3Y ranges). Tracking starts on
      // day one — the normal way apps do it: no dates and no
      // backfilled history from before the account existed.
      // Anything logged before creation (an event aimed at this
      // key earlier) still counts into the totals and the signed
      // series' opening balance, it just never gets a date on the
      // graph earlier than creation day. Sorted-pointer counting
      // keeps the append-only metrics O(days + events); the signed
      // follow metrics read their series value per day.
      const jan1Ms = Date.UTC(new Date().getUTCFullYear(), 0, 1);
      const createdMs = t(me.createdAt);
      let historyStart = createdMs > 0
        ? Math.floor(createdMs / DAY_MS) * DAY_MS
        : jan1Ms;
      const maxStart = todayStart - 1095 * DAY_MS;
      if (historyStart < maxStart) historyStart = maxStart;
      const sortedEvents = {} as Record<(typeof metricKeys)[number], number[]>;
      for (const k of metricKeys) sortedEvents[k] = [...events[k]].sort((a, b) => a - b);
      const pointers = {} as Record<(typeof metricKeys)[number], number>;
      for (const k of metricKeys) pointers[k] = 0;
      const history: z.infer<typeof profileAnalyticsResponse>["history"] = [];
      // Opening point: the TRUE cumulative value at the start of
      // the first tracked day, before that day's own events. This
      // is what makes a +1 land as a visible RISE: without it, a
      // follow that arrives on the account's first tracked day is
      // baked into every point of the series, so the total goes up
      // while the line, the end dot, the range delta and the %
      // change all stay flat (the owner's bug report). With the
      // opening point the series opens at the pre-event value and
      // steps up to the new total on the day the event lands —
      // line, dot, delta and % all read this same series, so they
      // always move together.
      const openingRow: z.infer<typeof profileAnalyticsResponse>["history"][number] = {
        day: new Date(historyStart).toISOString().slice(0, 10),
        followers: 0, following: 0, posts: 0, likes: 0, views: 0, comments: 0, saves: 0, reposts: 0,
      };
      for (const k of metricKeys) {
        const s = signedFor(k);
        if (s) {
          openingRow[k] = s.valueAt(historyStart);
          continue;
        }
        const arr = sortedEvents[k];
        let c = 0;
        while (c < arr.length && (arr[c] ?? Infinity) < historyStart) c++;
        openingRow[k] = c;
      }
      history.push(openingRow);
      for (let dayStart = historyStart; dayStart <= todayStart; dayStart += DAY_MS) {
        const dayEnd = dayStart + DAY_MS;
        const row: (typeof history)[number] = {
          day: new Date(dayStart).toISOString().slice(0, 10),
          followers: 0, following: 0, posts: 0, likes: 0, views: 0, comments: 0, saves: 0, reposts: 0,
        };
        for (const k of metricKeys) {
          const s = signedFor(k);
          if (s) {
            row[k] = s.valueAt(dayEnd);
            continue;
          }
          const arr = sortedEvents[k];
          let p = pointers[k];
          while (p < arr.length && (arr[p] ?? Infinity) < dayEnd) p++;
          pointers[k] = p;
          row[k] = p;
        }
        history.push(row);
      }
      // The 14-day cumulative series is the tail of the same history
      // — one source, so the Home mini graph and this page agree.
      const days: z.infer<typeof profileAnalyticsResponse>["days"] = history.slice(-14);
      // Last 7 days vs the 7 days before, per metric. Followers /
      // Following compare NET change (follows minus unfollows).
      const compare = metricKeys.map((k) => {
        const s = signedFor(k);
        const current = s ? s.netBetween(nowMs - 7 * DAY_MS, nowMs + 1) : events[k].filter((ts) => ts > nowMs - 7 * DAY_MS).length;
        const previous = s ? s.netBetween(nowMs - 14 * DAY_MS, nowMs - 7 * DAY_MS) : events[k].filter((ts) => ts > nowMs - 14 * DAY_MS && ts <= nowMs - 7 * DAY_MS).length;
        const delta = current - previous;
        const pct = previous > 0 ? Math.round((delta / previous) * 1000) / 10 : null;
        return { metric: k, current, previous, delta, pct };
      });
      // Per-month counts for EVERY month from the history start
      // through the current month (UTC, oldest first) — the month
      // dropdown lists them all. Followers / Following are the NET
      // change in the month, so a month of unfollows shows negative.
      const months = analyticsMonthWindows(historyStart).map((w) => {
        const row: (typeof zeroMonths)[number] = {
          key: w.key, label: w.label,
          followers: 0, following: 0, posts: 0, likes: 0, views: 0, comments: 0, saves: 0, reposts: 0,
        };
        for (const k of metricKeys) {
          const s = signedFor(k);
          row[k] = s ? s.netBetween(w.startMs, w.endMs) : events[k].filter((ts) => ts >= w.startMs && ts < w.endMs).length;
        }
        return row;
      });
      // The most recent individual events for the Activity list —
      // generic labels only, never another player's identity.
      const recentLabels: Record<(typeof metricKeys)[number], string> = {
        followers: "New follower",
        following: "Followed a player",
        posts: "You posted",
        likes: "Like received",
        views: "View received",
        comments: "Comment received",
        saves: "Save received",
        reposts: "Repost received",
      };
      const recent = [
        ...metricKeys.flatMap((k) => events[k].filter((ts) => ts > 0).map((ts) => ({ metric: k as string, label: recentLabels[k], at: new Date(ts).toISOString(), ts }))),
        ...signedDeltas.followers.filter((d) => d.delta < 0 && d.ts > 0).map((d) => ({ metric: "followers", label: "Lost a follower", at: new Date(d.ts).toISOString(), ts: d.ts })),
        ...signedDeltas.following.filter((d) => d.delta < 0 && d.ts > 0).map((d) => ({ metric: "following", label: "Unfollowed a player", at: new Date(d.ts).toISOString(), ts: d.ts })),
      ]
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 12)
        .map(({ metric, label, at }) => ({ metric, label, at }));
      return { hasProfile: true, gamertag: me.gamertag, totals, days, history, compare, months, recent };
    },
  }),

  getTrendingSearches: defineAction({
    description: "Returns the most searched terms in ViceSunshine, ranked by their real recorded search counts (every submitted search is counted by recordSearch). Until real searches exist for a slot, curated popular topics fill the list with a count of 0 — counts are never invented.",
    request: z.object({}),
    response: z.object({
      items: z.array(z.object({ term: z.string(), count: z.number() })),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.searchTerms).orderBy(desc(schema.searchTerms.count), desc(schema.searchTerms.updatedAt));
      const items = rows.slice(0, 10).map((r) => ({ term: r.term, count: r.count }));
      const seen = new Set(items.map((i) => i.term.toLowerCase()));
      const curated = ["GTA VI trailer", "Lucia Caminos", "Easter eggs", "Car meet", "Weapons", "Vehicles", "Missions", "Vice City", "Crews", "Release date"];
      for (const term of curated) {
        if (items.length >= 10) break;
        if (seen.has(term.toLowerCase())) continue;
        seen.add(term.toLowerCase());
        items.push({ term, count: 0 });
      }
      return { items };
    },
  }),

  recordSearch: defineAction({
    description: "Counts one real submitted search term, so the search overlay's Most searched list ranks by what players actually searched for. Called when a search is submitted (Enter, a trending tap, or opening the full results) — never on every keystroke.",
    request: z.object({ term: z.string().trim().min(2).max(120) }),
    response: recordSearchResponse,
    async handler(ctx, args): Promise<z.infer<typeof recordSearchResponse>> {
      const db = ctx.db<typeof schema>();
      const display = args.term.replace(/\s+/g, " ").trim();
      const key = display.toLowerCase();
      const existing = await db.select().from(schema.searchTerms).where(eq(schema.searchTerms.termKey, key));
      const row = existing[0];
      if (row) {
        const count = row.count + 1;
        await db.update(schema.searchTerms).set({ count, term: display, updatedAt: new Date() }).where(eq(schema.searchTerms.id, row.id));
        return { ok: true, count };
      }
      await db.insert(schema.searchTerms).values({ termKey: key, term: display, count: 1 });
      return { ok: true, count: 1 };
    },
  }),

  globalSearch: defineAction({
    description: "Searches all of ViceSunshine at once for the global search overlay and the full search results view: Users (players), Videos (video/clip Feed posts), News and Feed topics, Events, Bugs, Guides, Crews and the Database, grouped, each group limited. Matching mirrors each section's own search (title / body / author / name fields).",
    request: z.object({
      query: z.string().max(120).default(""),
      playerKey: z.string().max(80).default(""),
      limitPerGroup: z.number().int().min(1).max(20).default(5),
    }),
    response: z.object({
      query: z.string(),
      total: z.number(),
      news: z.array(searchHit),
      feed: z.array(searchHit),
      videos: z.array(searchHit),
      events: z.array(searchHit),
      bugs: z.array(searchHit),
      guides: z.array(searchHit),
      crews: z.array(searchHit),
      players: z.array(searchHit),
      database: z.array(searchHit),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const q = args.query.trim().toLowerCase();
      const empty = { query: args.query.trim(), total: 0, news: [], feed: [], videos: [], events: [], bugs: [], guides: [], crews: [], players: [], database: [] };
      if (!q) return empty;
      const lim = args.limitPerGroup;
      const [newsRows, feedRows, eventRows, bugRows, guideRows, clanRows, memberRows, profileRows, dbRows] = await Promise.all([
        db.select().from(schema.news).orderBy(desc(schema.news.id)),
        db.select().from(schema.feedPosts).orderBy(desc(schema.feedPosts.id)),
        db.select().from(schema.events).orderBy(desc(schema.events.id)),
        db.select().from(schema.bugs),
        db.select().from(schema.guides).orderBy(desc(schema.guides.id)),
        db.select().from(schema.clans),
        db.select().from(schema.clanMembers),
        db.select().from(schema.profiles),
        db.select().from(schema.dbEntries),
      ]);
      const memberCounts = new Map<number, number>();
      for (const m of memberRows) memberCounts.set(m.clanId, (memberCounts.get(m.clanId) ?? 0) + 1);
      const news = newsRows
        .filter((r) => r.title.toLowerCase().includes(q) || r.summary.toLowerCase().includes(q))
        .slice(0, lim)
        .map((r) => ({ refId: r.id, refKey: "", title: r.title, subtitle: [r.category, r.sourceName, r.publishedAt].filter(Boolean).join(" · "), extra: "" }));
      const feed = feedRows
        .filter((r) => r.flagged !== 1 || r.authorKey === args.playerKey)
        .filter((r) => r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q) || r.author.toLowerCase().includes(q))
        .slice(0, lim)
        .map((r) => ({ refId: r.id, refKey: "", title: r.title || `${r.author} — ${r.kind}`, subtitle: `${r.kind} · by ${r.author}`, extra: "" }));
      // Videos: the video posts inside the Feed — YouTube / native
      // video media, or a clip-style kind — as their own group, so
      // searching a creator or a clip title finds the video itself.
      const videos = feedRows
        .filter((r) => r.flagged !== 1 || r.authorKey === args.playerKey)
        .filter((r) => {
          const m = feedMediaOf(r.mediaUrl);
          return m.mediaType === "youtube" || m.mediaType === "video" || ["Clip", "Streamer Clip", "Gameplay", "Tutorial"].includes(r.kind);
        })
        .filter((r) => r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q) || r.author.toLowerCase().includes(q))
        .slice(0, lim)
        .map((r) => ({ refId: r.id, refKey: "", title: r.title || `${r.author} — ${r.kind}`, subtitle: `Video · ${r.kind} · by ${r.author}`, extra: "" }));
      const events = eventRows
        .filter((r) => r.title.toLowerCase().includes(q) || r.type.toLowerCase().includes(q) || r.host.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
        .slice(0, lim)
        .map((r) => ({ refId: r.id, refKey: "", title: r.title, subtitle: [r.type, r.startsAt, r.platform, r.host ? `hosted by ${r.host}` : ""].filter(Boolean).join(" · "), extra: "" }));
      const bugs = bugRows
        .filter((r) => r.title.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
        .sort((a, b) => b.votes - a.votes)
        .slice(0, lim)
        .map((r) => ({ refId: r.id, refKey: "", title: r.title, subtitle: `${r.platform} · ${r.status} · ${r.votes} votes`, extra: "" }));
      const guides = guideRows
        .filter((r) => r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q) || r.category.toLowerCase().includes(q))
        .slice(0, lim)
        .map((r) => ({ refId: r.id, refKey: "", title: r.title, subtitle: [r.category, r.author].filter(Boolean).join(" · "), extra: "" }));
      const crews = clanRows
        .filter((r) => r.name.toLowerCase().includes(q) || r.tag.toLowerCase().includes(q) || r.motto.toLowerCase().includes(q))
        .slice(0, lim)
        .map((r) => ({ refId: r.id, refKey: "", title: r.name, subtitle: `[${r.tag}] · ${r.platform} · ${memberCounts.get(r.id) ?? 0} members`, extra: "" }));
      const players = profileRows
        .filter((r) => r.gamertag.toLowerCase().includes(q) || r.displayName.toLowerCase().includes(q))
        .slice(0, lim)
        // refKey stays EMPTY for players on purpose: a playerKey is
        // that account's device credential, never a public ID — it
        // must never be returned for another player. The client keys
        // the row by refId and navigates by re-searching the gamertag.
        .map((r) => ({ refId: r.id, refKey: "", title: r.displayName.trim() || r.gamertag, subtitle: `@${r.gamertag} · ${r.platform}${r.region ? ` · ${r.region}` : ""}`, extra: "" }));
      const database = dbRows
        .filter((r) => r.name.toLowerCase().includes(q) || r.category.toLowerCase().includes(q) || r.manufacturer.toLowerCase().includes(q))
        .slice(0, lim)
        .map((r) => ({ refId: r.id, refKey: "", title: r.name, subtitle: `${r.kind} · ${r.status}`, extra: r.kind }));
      const total = news.length + feed.length + videos.length + events.length + bugs.length + guides.length + crews.length + players.length + database.length;
      return { query: args.query.trim(), total, news, feed, videos, events, bugs, guides, crews, players, database };
    },
  }),

  listNews: defineAction({
    description: "Lists news items, optionally filtered by category, newest first.",
    request: z.object({
      category: z.string().max(20).default("All"),
      search: z.string().max(120).default(""),
    }),
    response: z.object({ items: z.array(newsItem) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let rows = await db.select().from(schema.news).orderBy(desc(schema.news.id));
      if (args.category !== "All") {
        rows = rows.filter((r) => r.category === args.category);
      }
      const q = args.search.trim().toLowerCase();
      if (q) {
        rows = rows.filter(
          (r) =>
            r.title.toLowerCase().includes(q) || r.summary.toLowerCase().includes(q),
        );
      }
      return {
        items: rows.map((r) => ({
          id: r.id,
          title: r.title,
          summary: r.summary,
          category: r.category,
          sourceName: r.sourceName,
          sourceUrl: r.sourceUrl,
          publishedAt: r.publishedAt,
        })),
      };
    },
  }),

  addNews: defineAction({
    description: "Adds a community news post with a source link.",
    request: z.object({
      title: z.string().trim().min(3).max(200),
      summary: z.string().trim().max(1200).default(""),
      category: z.enum(["Official", "Patch", "Rumor", "Community"]).default("Community"),
      sourceName: z.string().trim().max(80).default(""),
      sourceUrl: z.string().trim().max(500).default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const today = new Date().toISOString().slice(0, 10);
      const res = await db
        .insert(schema.news)
        .values({ ...args, publishedAt: today })
        .returning({ id: schema.news.id });
      ctx.invalidateQueries();
      return { id: res[0]?.id ?? 0 };
    },
  }),

  refreshNews: defineAction({
    description:
      "Searches the web for the latest GTA VI news and patch notes and stores new items, deduped by source URL. Runs automatically on a schedule and from open pages; a run that already landed in the last 3 minutes makes repeat calls a no-op, so live polling never hammers the search.",
    request: z.object({}),
    response: z.object({ added: z.number(), checkedAt: z.string() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const lastNewsRefresh = await getMeta(ctx, "last_refreshed_at");
      if (lastNewsRefresh && Date.now() - new Date(lastNewsRefresh).getTime() < 3 * 60 * 1000) {
        return { added: 0, checkedAt: lastNewsRefresh };
      }
      let added = 0;
      const existing = await db.select().from(schema.news);
      const seenUrls = new Set(existing.map((r) => r.sourceUrl).filter(Boolean));
      const seenTitles = new Set(existing.map((r) => r.title.toLowerCase()));

      const queries = [
        "GTA VI Grand Theft Auto VI latest news Rockstar Games",
        "GTA VI patch notes update version PS5 Xbox",
        "GTA VI glitch bug discovered Grand Theft Auto VI",
        "GTA VI tips tricks guide Grand Theft Auto VI",
      ];
      for (const query of queries) {
        let results: { title?: string; url?: string; content?: string }[] = [];
        try {
          const raw = (await ctx.tool.web_search(query)) as unknown;
          const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
          // The search tool nests results under content.results and
          // calls the text field "snippet".
          const container = parsed as {
            content?: { results?: Record<string, unknown>[] };
            results?: Record<string, unknown>[];
          };
          const list = container?.content?.results ?? container?.results ?? (Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []);
          results = list.map((r) => ({
            title: typeof r.title === "string" ? r.title : undefined,
            url: typeof r.url === "string" ? r.url : undefined,
            content: typeof r.content === "string" ? r.content : typeof r.snippet === "string" ? r.snippet : undefined,
          }));
        } catch {
          results = [];
        }
        for (const r of results) {
          const url = (r.url ?? "").trim();
          const title = (r.title ?? "").trim();
          if (!url || !title || seenUrls.has(url) || seenTitles.has(title.toLowerCase())) {
            continue;
          }
          if (/download|apk|crack|free gta/i.test(title)) continue;
          seenUrls.add(url);
          seenTitles.add(title.toLowerCase());
          const isPatch = /patch|update|version/i.test(title) && query.includes("patch");
          const host = (() => {
            try {
              return new URL(url).hostname.replace(/^www\./, "");
            } catch {
              return "";
            }
          })();
          const isRockstarOfficial = host === "rockstargames.com";
          await db.insert(schema.news).values({
            title: title.slice(0, 200),
            summary: cleanFoundText(r.content ?? "").slice(0, 600),
            category: isRockstarOfficial ? "Official" : isPatch ? "Patch" : "Community",
            sourceName: isRockstarOfficial ? "Rockstar Games" : host || "Web",
            sourceUrl: url.slice(0, 500),
            publishedAt: new Date().toISOString().slice(0, 10),
          });
          added += 1;
        }
      }
      const now = new Date().toISOString();
      await setMeta(ctx, "last_refreshed_at", now);
      ctx.invalidateQueries();
      return { added, checkedAt: now };
    },
  }),

  refreshFeedMedia: defineAction({
    description: "Automatic Feed refresh: searches the web for real GTA VI videos (official trailers and news videos, streamer clips, tutorials, gameplay, car meets, memes, plus newly reported glitches, tips and tricks as they appear online) and adds new ones as Automatic posts linked to the original YouTube source, plus the day's trending GTA VI news stories as Automatic News posts linked to the original article. Videos are embedded/linked, never re-uploaded; deduped by video id, title and source URL.",
    request: z.object({}),
    response: z.object({ added: z.number(), checkedAt: z.string() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const lastFeedRefresh = await getMeta(ctx, "last_feed_media_refresh_at");
      if (lastFeedRefresh && Date.now() - new Date(lastFeedRefresh).getTime() < 5 * 60 * 1000) {
        return { added: 0, checkedAt: lastFeedRefresh };
      }
      let added = 0;
      const existing = await db.select().from(schema.feedPosts);
      // Re-verification sweep: recheck every Automatic video already
      // in the Feed. A video YouTube now says is gone or not
      // embeddable loses its player for good — the post stays as text
      // with a working Watch on YouTube link in the body, so nothing
      // in the Feed can sit there as a dead black box. Community
      // posts are never touched (their own player falls back to a
      // thumbnail + link client-side if a video dies).
      {
        const autoVideoIds = [
          ...new Set(
            existing
              .filter((r) => r.auto === 1)
              .map((r) => youtubeIdOf(r.mediaUrl))
              .filter(Boolean),
          ),
        ] as string[];
        const deadIds = new Set<string>();
        for (let i = 0; i < autoVideoIds.length; i += 10) {
          const chunk = autoVideoIds.slice(i, i + 10);
          const verdicts = await Promise.all(chunk.map((id) => youtubeDefinitivelyDead(id)));
          chunk.forEach((id, j) => {
            if (verdicts[j]) deadIds.add(id);
          });
        }
        if (deadIds.size > 0) {
          for (const r of existing) {
            const vid = youtubeIdOf(r.mediaUrl);
            if (!vid || !deadIds.has(vid) || r.auto !== 1) continue;
            const watch = `https://www.youtube.com/watch?v=${vid}`;
            await db
              .update(schema.feedPosts)
              .set({
                mediaUrl: "",
                body: r.body.includes(watch)
                  ? r.body
                  : `${r.body}\n\nThis video can no longer play inside ViceSunshine — watch it on YouTube: ${watch}`,
              })
              .where(eq(schema.feedPosts.id, r.id));
            r.mediaUrl = "";
          }
        }
      }
      const seenVideoIds = new Set(
        existing.map((r) => youtubeIdOf(r.mediaUrl)).filter(Boolean),
      );
      const seenTitles = new Set(existing.map((r) => r.title.toLowerCase()).filter(Boolean));

      // One search per Feed category. Only real YouTube watch/shorts
      // URLs are accepted, so every automatic post embeds the original
      // video from its source — nothing is copied or re-uploaded, and
      // nothing is invented when a search finds nothing usable.
      const searches: { query: string; kind: string; blurb: string }[] = [
        { query: "site:youtube.com GTA VI Grand Theft Auto VI official trailer Rockstar Games", kind: "News", blurb: "The latest GTA VI trailer video doing the rounds — check the channel at the source to confirm it is the official Rockstar upload." },
        { query: "site:youtube.com GTA VI news update video", kind: "News", blurb: "GTA VI news video coverage." },
        { query: "site:youtube.com GTA VI patch update video", kind: "Clip", blurb: "GTA VI update / patch video coverage." },
        { query: "site:youtube.com GTA VI streamer clip", kind: "Streamer Clip", blurb: "A popular streamer clip about GTA VI." },
        { query: "site:youtube.com GTA VI tutorial guide video", kind: "Tutorial", blurb: "A GTA VI tutorial / guide video." },
        { query: "site:youtube.com GTA VI gameplay video", kind: "Gameplay", blurb: "GTA VI gameplay video." },
        { query: "site:youtube.com GTA VI car meet video", kind: "Car Meet", blurb: "A GTA car meet video to inspire ViceSunshine community meets." },
        { query: "site:youtube.com GTA VI meme video", kind: "Meme", blurb: "A GTA VI meme video doing the rounds." },
        { query: "site:youtube.com GTA VI funny moments video", kind: "Funny", blurb: "Funny GTA VI moments." },
        { query: "site:youtube.com GTA VI glitch bug discovered video", kind: "Gameplay", blurb: "A newly reported GTA VI glitch / bug, posted as a community report with the source linked — confirmed issues are followed up in the Bug Tracker. Found a glitch yourself? Report it there." },
        { query: "site:youtube.com GTA VI tips and tricks video", kind: "Tutorial", blurb: "GTA VI tips and tricks from the community — checked against the source before you rely on them." },
      ];
      for (const s of searches) {
        if (added >= 18) break;
        let results: { title?: string; url?: string; content?: string }[] = [];
        try {
          const raw = (await ctx.tool.web_search(s.query)) as unknown;
          const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
          // The search tool nests results under content.results and
          // calls the text field "snippet".
          const container = parsed as {
            content?: { results?: Record<string, unknown>[] };
            results?: Record<string, unknown>[];
          };
          const list = container?.content?.results ?? container?.results ?? (Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []);
          results = list.map((r) => ({
            title: typeof r.title === "string" ? r.title : undefined,
            url: typeof r.url === "string" ? r.url : undefined,
            content: typeof r.content === "string" ? r.content : typeof r.snippet === "string" ? r.snippet : undefined,
          }));
        } catch {
          results = [];
        }
        let perQuery = 0;
        for (const r of results) {
          if (perQuery >= 3 || added >= 18) break;
          const title = stripEmoji((r.title ?? "").replace(/\s+/g, " ").trim());
          if (!title) continue;
          if (/leak|download|apk|crack|free gta|mod menu/i.test(title)) continue;
          if (seenTitles.has(title.toLowerCase())) continue;
          // Candidate video URLs: the result itself when it is a
          // YouTube page, otherwise YouTube URLs embedded in the
          // result's content (trailer round-ups embed the official
          // uploads). Listicle pages that round up many videos are
          // skipped for content embeds so a title never gets paired
          // with the wrong video.
          const candidates: string[] = [];
          const directUrl = (r.url ?? "").trim();
          if (youtubeIdOf(directUrl)) candidates.push(directUrl);
          if (candidates.length === 0 && !/all trailers|every trailer|watch all|all .* trailers/i.test(title)) {
            const found = (r.content ?? "").match(
              /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?[^\s"'<>)\]]+|embed\/[A-Za-z0-9_-]{6,20}|shorts\/[A-Za-z0-9_-]{6,20})|youtu\.be\/[A-Za-z0-9_-]{6,20})/g,
            );
            for (const u of found ?? []) {
              if (youtubeIdOf(u)) candidates.push(u.replace(/[?&#].*$/, (m) => (m.startsWith("?v=") || m.startsWith("&v=") ? m : "")));
            }
          }
          const url = candidates.find((u) => !seenVideoIds.has(youtubeIdOf(u))) ?? "";
          const videoId = youtubeIdOf(url);
          if (!videoId || !url) continue;
          // Never store a video YouTube says is gone or not
          // embeddable — it would sit in the Feed as a dead player.
          if (!(await youtubeEmbeddable(videoId))) continue;
          seenVideoIds.add(videoId);
          seenTitles.add(title.toLowerCase());
          let sourceName = "YouTube";
          try {
            sourceName = new URL(url).hostname.replace(/^www\./, "");
          } catch {
            sourceName = "YouTube";
          }
          const snippet = cleanFoundText(r.content ?? "").slice(0, 280);
          await db.insert(schema.feedPosts).values({
            authorKey: FEED_AUTO_KEY,
            author: "ViceSunshine Automatic",
            kind: s.kind as typeof schema.feedPosts.$inferInsert.kind,
            title: title.slice(0, 140),
            body:
              `${s.blurb} Found automatically by ViceSunshine from ${sourceName} — watch the original at the source; ViceSunshine never re-uploads videos.` +
              (snippet ? `\n\n${snippet}` : ""),
            mediaUrl: url.slice(0, 500),
            auto: 1,
            sourceName,
            sourceUrl: url.slice(0, 500),
          });
          added += 1;
          perQuery += 1;
        }
      }
      // Rockstar official pass (owner's direction): when Rockstar
      // Games posts something official — a GTA VI announcement, a
      // money / bonus post, any Newswire post — it ALSO lands in the
      // community Feed as an automatic post authored "Rockstar
      // Games", with the source link to Rockstar's original post.
      // Only results hosted on rockstargames.com itself count: a
      // third-party article ABOUT Rockstar is not a Rockstar post.
      // Deduped by source URL and title, like every automatic pass;
      // nothing is stored when the search finds no Rockstar post.
      {
        const rockstarSeenUrls = new Set(existing.map((r) => r.sourceUrl).filter(Boolean));
        const rockstarSearches = [
          "site:rockstargames.com Grand Theft Auto VI",
          "site:rockstargames.com newswire GTA bonus money week",
        ];
        let rockstarAdded = 0;
        for (const q of rockstarSearches) {
          if (rockstarAdded >= 4) break;
          let perQuery = 0;
          let results: { title?: string; url?: string; content?: string }[] = [];
          try {
            const raw = (await ctx.tool.web_search(q)) as unknown;
            const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
            const container = parsed as {
              content?: { results?: Record<string, unknown>[] };
              results?: Record<string, unknown>[];
            };
            const list = container?.content?.results ?? container?.results ?? (Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []);
            results = list.map((r) => ({
              title: typeof r.title === "string" ? r.title : undefined,
              url: typeof r.url === "string" ? r.url : undefined,
              content: typeof r.content === "string" ? r.content : typeof r.snippet === "string" ? r.snippet : undefined,
            }));
          } catch {
            results = [];
          }
          for (const r of results) {
            if (rockstarAdded >= 4 || perQuery >= 2) break;
            const title = stripEmoji((r.title ?? "").replace(/\s+/g, " ").trim());
            const url = (r.url ?? "").trim();
            if (title.length < 12 || !/^https?:\/\//i.test(url)) continue;
            let host = "";
            try {
              host = new URL(url).hostname.replace(/^www\./, "");
            } catch {
              continue;
            }
            if (host !== "rockstargames.com") continue;
            if (/leak|download|apk|crack|free gta|mod menu/i.test(title)) continue;
            if (seenTitles.has(title.toLowerCase()) || rockstarSeenUrls.has(url)) continue;
            const snippet = cleanFoundText(r.content ?? "").slice(0, 400);
            const imageBlobKey = await fetchEditorialImage(ctx, url);
            seenTitles.add(title.toLowerCase());
            rockstarSeenUrls.add(url);
            await db.insert(schema.feedPosts).values({
              authorKey: FEED_AUTO_KEY,
              author: "Rockstar Games",
              kind: "News",
              imageBlobKey,
              title: title.slice(0, 140),
              body:
                "Official post from Rockstar Games, shared into the ViceSunshine community automatically — the original is on Rockstar's own site, linked as the source below." +
                (snippet ? `\n\n${snippet}` : ""),
              mediaUrl: "",
              auto: 1,
              sourceName: "Rockstar Games",
              sourceUrl: url.slice(0, 500),
            });
            rockstarAdded += 1;
            perQuery += 1;
            added += 1;
          }
        }
      }
      // Trending news pass: the day's GTA VI news stories (not just
      // videos) join the Feed as Automatic News posts — bold headline,
      // summary text, and a link to the original article, exactly like
      // the news items in a social feed. Deduped by title and source
      // URL; nothing is stored when a search finds nothing usable, and
      // no article text or image is copied — the summary is the search
      // snippet and the full story stays at the source.
      const seenSourceUrls = new Set(existing.map((r) => r.sourceUrl).filter(Boolean));
      const newsSearches = ["GTA VI news today", "GTA VI streamer news", "first player finishes GTA VI story", "Grand Theft Auto VI headline news"];
      let newsAdded = 0;
      for (const q of newsSearches) {
        if (newsAdded >= 6) break;
        let perNewsQuery = 0;
        let results: { title?: string; url?: string; content?: string }[] = [];
        try {
          const raw = (await ctx.tool.web_search(q)) as unknown;
          const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
          const container = parsed as {
            content?: { results?: Record<string, unknown>[] };
            results?: Record<string, unknown>[];
          };
          const list = container?.content?.results ?? container?.results ?? (Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []);
          results = list.map((r) => ({
            title: typeof r.title === "string" ? r.title : undefined,
            url: typeof r.url === "string" ? r.url : undefined,
            content: typeof r.content === "string" ? r.content : typeof r.snippet === "string" ? r.snippet : undefined,
          }));
        } catch {
          results = [];
        }
        for (const r of results) {
          if (newsAdded >= 6 || perNewsQuery >= 2) break;
          const title = stripEmoji((r.title ?? "").replace(/\s+/g, " ").trim());
          const url = (r.url ?? "").trim();
          if (title.length < 15 || !/^https?:\/\//i.test(url)) continue;
          if (youtubeIdOf(url)) continue; // videos are handled by the pass above
          if (/leak|download|apk|crack|free gta|mod menu/i.test(title)) continue;
          if (seenTitles.has(title.toLowerCase()) || seenSourceUrls.has(url)) continue;
          const snippet = cleanFoundText(r.content ?? "").slice(0, 400);
          if (!snippet) continue;
          let sourceName = "the web";
          try {
            sourceName = new URL(url).hostname.replace(/^www\./, "");
          } catch {
            continue;
          }
          seenTitles.add(title.toLowerCase());
          seenSourceUrls.add(url);
          const imageBlobKey = await fetchEditorialImage(ctx, url);
          await db.insert(schema.feedPosts).values({
            authorKey: FEED_AUTO_KEY,
            author: "ViceSunshine Automatic",
            kind: "News",
            imageBlobKey,
            title: title.slice(0, 140),
            body: `Trending GTA VI news, found automatically by ViceSunshine from ${sourceName} — read the full story at the source.\n\n${snippet}`,
            mediaUrl: "",
            auto: 1,
            sourceName,
            sourceUrl: url.slice(0, 500),
          });
          newsAdded += 1;
          perNewsQuery += 1;
          added += 1;
        }
      }
      const now = new Date().toISOString();
      await setMeta(ctx, "last_feed_media_refresh_at", now);
      ctx.invalidateQueries();
      return { added, checkedAt: now };
    },
  }),

  listPatches: defineAction({
    description: "Lists all tracked game updates, newest first.",
    request: z.object({}),
    response: z.object({ items: z.array(patchItem) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.patches).orderBy(desc(schema.patches.id));
      return {
        items: rows.map((r) => ({
          id: r.id,
          version: r.version,
          releaseDate: r.releaseDate,
          sizePs5: r.sizePs5,
          sizeXbox: r.sizeXbox,
          notes: r.notes,
          sourceUrl: r.sourceUrl,
          createdAt: r.createdAt ? r.createdAt.toISOString() : "",
        })),
      };
    },
  }),

  addPatch: defineAction({
    description: "Adds an update row to the patch tracker.",
    request: z.object({
      version: z.string().trim().min(3).max(30),
      releaseDate: z.string().trim().max(20).default(""),
      sizePs5: z.string().trim().max(30).default(""),
      sizeXbox: z.string().trim().max(30).default(""),
      notes: z.string().trim().max(2000).default("No official patch notes published"),
      sourceUrl: z.string().trim().max(500).default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const res = await db
        .insert(schema.patches)
        .values({ ...args, notes: args.notes || "No official patch notes published" })
        .returning({ id: schema.patches.id });
      ctx.invalidateQueries();
      return { id: res[0]?.id ?? 0 };
    },
  }),

  listBugs: defineAction({
    description: "Lists bug & glitch reports with sorting and platform filter — both automatic finds (from Rockstar / GTA sources, news and creators, each with its source link) and community reports filed by players in the tracker — plus when the automatic check last ran and how many of each kind the tracker holds.",
    request: z.object({
      sort: z.enum(["votes", "newest", "platform"]).default("votes"),
      platform: z.string().max(10).default("All"),
      search: z.string().max(120).default(""),
      playerKey: z.string().max(80).default(""),
    }),
    response: z.object({
      items: z.array(bugItem),
      lastRefreshedAt: z.string(),
      autoCount: z.number(),
      communityCount: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const allRows = await db.select().from(schema.bugs);
      const autoCount = allRows.filter((r) => r.auto === 1).length;
      const communityCount = allRows.length - autoCount;
      let rows = [...allRows];
      const bugReports = await db.select().from(schema.bugReports);
      const myVotes = args.playerKey
        ? new Set(
            (await db.select().from(schema.bugVotes).where(eq(schema.bugVotes.playerKey, args.playerKey))).map((v) => v.bugId),
          )
        : new Set<number>();
      if (args.platform !== "All") rows = rows.filter((r) => r.platform === args.platform || r.platform === "Both");
      const q = args.search.trim().toLowerCase();
      if (q) rows = rows.filter((r) => r.title.toLowerCase().includes(q) || r.description.toLowerCase().includes(q) || r.sourceName.toLowerCase().includes(q));
      rows.sort((a, b) => {
        if (args.sort === "votes") return b.votes - a.votes;
        if (args.sort === "platform") return a.platform.localeCompare(b.platform) || b.votes - a.votes;
        return b.id - a.id;
      });
      return {
        items: rows.map((r) => ({
          id: r.id,
          title: r.title,
          platform: r.platform,
          description: r.description,
          status: r.status === "Fixed" && r.fixedIn ? `Fixed in ${r.fixedIn}` : r.status,
          fixedIn: r.fixedIn,
          workaround: r.workaround,
          votes: r.votes,
          votedByMe: myVotes.has(r.id),
          reporter: r.reporter,
          reports: bugReports.filter((x) => x.bugId === r.id).length,
          flagged: r.flagged === 1,
          sourceName: r.sourceName,
          sourceUrl: r.sourceUrl,
          auto: r.auto === 1,
          createdAt: r.createdAt.toISOString(),
        })),
        lastRefreshedAt: await getMeta(ctx, "last_bugs_refresh_at"),
        autoCount,
        communityCount,
      };
    },
  }),

  refreshBugs: defineAction({
    description: "Automatic Bug & glitch tracker refresh: searches the web for GTA VI bugs and glitches reported by Rockstar / GTA sources, news and creators / influencers, and adds each distinct, explicitly reported issue as an Automatic tracker entry with its source linked — alongside (never replacing) community reports players file themselves. Runs automatically on a schedule and from open pages; a run that already landed in the last 10 minutes makes repeat calls a no-op, so live polling never hammers the search. Nothing is invented: an issue is only stored when a search result actually describes it, and it always starts as Reported until players here confirm it.",
    request: z.object({}),
    response: z.object({ added: z.number(), checkedAt: z.string() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const lastRefresh = await getMeta(ctx, "last_bugs_refresh_at");
      if (lastRefresh && Date.now() - new Date(lastRefresh).getTime() < 10 * 60 * 1000) {
        return { added: 0, checkedAt: lastRefresh };
      }
      const now = new Date().toISOString();
      let added = 0;
      const queries = [
        "GTA VI bug glitch discovered Grand Theft Auto VI players report",
        "GTA VI known issues bugs Rockstar Games support",
        "site:youtube.com GTA VI glitch bug discovered",
        "GTA VI glitch bug streamer creator report Leonida",
        "Grand Theft Auto VI bug fix patch known issues players",
      ];
      const found: { title: string; url: string; content: string }[] = [];
      for (const q of queries) {
        found.push(...(await webSearchResults(ctx, q)));
      }
      const usableByUrl = new Map<string, { title: string; url: string; content: string }>();
      for (const r of found) {
        const url = (r.url ?? "").trim();
        if (!url.startsWith("http") || usableByUrl.has(url)) continue;
        const title = (r.title ?? "").trim();
        if (!title || /download|apk|crack|free gta|mod menu/i.test(title)) continue;
        usableByUrl.set(url, r);
      }
      const usable = [...usableByUrl.values()];
      if (usable.length > 0) {
        const existing = await db.select().from(schema.bugs);
        const seenUrls = new Set(existing.map((r) => r.sourceUrl).filter(Boolean));
        const seenTitles = new Set(existing.map((r) => r.title.trim().toLowerCase()));
        const resultUrls = new Set(usable.map((r) => r.url));
        let extracted: { title: string; platform: string; description: string; workaround: string; sourceUrl: string }[] = [];
        try {
          const extraction = await ctx.inference.complete(
            `Below are web search results about GTA VI bugs and glitches — from Rockstar / GTA sources, news sites and creators / influencers. Extract ONLY distinct, specific bugs or glitches that a result explicitly describes (a concrete in-game problem players hit — not general articles, not tips, not the game itself, not a patch announcement with no bug named). For each bug give: title (short, the bug itself, e.g. "Cars sink through Ocean Drive bridge"), platform (PS5, Xbox or Both — only state PS5 or Xbox when a result says that platform, otherwise Both), description (one or two sentences from the results on what happens and, when stated, how to reproduce it, in your own words), workaround (only when a result states one, otherwise ""), and sourceUrl copied EXACTLY from the result that describes it. If no result clearly describes a specific bug or glitch, return an empty list. Never invent a bug, a platform, a step or a workaround that is not in the results.\n\nRESULTS:\n${usable.map((r, i) => `[${i}] ${r.title}\nURL: ${r.url}\n${cleanFoundText(r.content).slice(0, 400)}`).join("\n\n")}`,
            {
              schema: z.object({
                bugs: z.array(
                  z.object({
                    title: z.string(),
                    platform: z.string(),
                    description: z.string(),
                    workaround: z.string(),
                    sourceUrl: z.string(),
                  }),
                ),
              }),
            },
          );
          extracted = extraction.bugs;
        } catch {
          // Inference unavailable: fall back to the clearest video /
          // article results whose own titles name a bug or glitch —
          // still grounded strictly in the results, nothing invented.
          extracted = usable
            .filter((r) => /glitch|bug|broken|stuck|crash|fall through|invisible/i.test(r.title))
            .slice(0, 3)
            .map((r) => ({
              title: stripEmoji(r.title.replace(/\s+/g, " ").trim()),
              platform: "Both",
              description: cleanFoundText(r.content).slice(0, 600),
              workaround: "",
              sourceUrl: r.url,
            }));
        }
        for (const f of extracted) {
          if (added >= 6) break;
          const title = stripEmoji(f.title.replace(/\s+/g, " ").trim()).slice(0, 160);
          if (title.length < 8) continue;
          const sourceUrl = (f.sourceUrl ?? "").trim();
          if (!sourceUrl || !resultUrls.has(sourceUrl) || seenUrls.has(sourceUrl)) continue;
          const lower = title.toLowerCase();
          const dupe = [...seenTitles].some(
            (n) => n === lower || (lower.length >= 10 && n.includes(lower)) || (n.length >= 10 && lower.includes(n)),
          );
          if (dupe) continue;
          const description = cleanFoundText(f.description ?? "").slice(0, 2000);
          if (description.length < 10) continue;
          const platform = f.platform === "PS5" || f.platform === "Xbox" ? f.platform : "Both";
          seenUrls.add(sourceUrl);
          seenTitles.add(lower);
          await db.insert(schema.bugs).values({
            title,
            platform: platform as "PS5" | "Xbox" | "Both",
            description,
            workaround: cleanFoundText(f.workaround ?? "").slice(0, 1000),
            status: "Reported",
            votes: 1,
            reporter: "",
            sourceName: hostnameOf(sourceUrl),
            sourceUrl: sourceUrl.slice(0, 500),
            auto: 1,
          });
          added += 1;
        }
      }
      await setMeta(ctx, "last_bugs_refresh_at", now);
      ctx.invalidateQueries();
      return { added, checkedAt: now };
    },
  }),

  refreshDbEntries: defineAction({
    description: "Automatic Database upkeep: searches the web (Rockstar's official GTA VI pages first, then GTA news coverage) for new or changed GTA VI vehicles, weapons, characters and locations, then adds genuinely new entries and updates existing ones on its own — no one adds them by hand. An entry is only stored when a search result explicitly names it as a GTA VI entry, with its source copied exactly; a 'Confirmed in trailer' status is never downgraded, and an official-source entry is never overwritten by a weaker claim. New entries are flagged auto-discovered so the catalog reconcile never deletes them, and the artwork pipeline paints their pictures automatically. Runs on a schedule and when the Database opens; throttled to one real check per 30 minutes.",
    request: z.object({}),
    response: z.object({ added: z.number(), updated: z.number(), checkedAt: z.string() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const lastResearch = await getMeta(ctx, "last_db_research_at");
      if (lastResearch && Date.now() - new Date(lastResearch).getTime() < 30 * 60 * 1000) {
        return { added: 0, updated: 0, checkedAt: lastResearch };
      }
      const now = new Date().toISOString();
      let added = 0;
      let updated = 0;
      const queries = [
        "GTA VI new vehicle revealed Rockstar Games Grand Theft Auto VI",
        "GTA VI new weapon character location revealed official trailer",
        "site:rockstargames.com GTA VI vehicles characters locations",
        "Grand Theft Auto VI new car gun character announced news",
        "GTA VI database new vehicles weapons characters locations revealed",
      ];
      const found: { title: string; url: string; content: string }[] = [];
      for (const q of queries) {
        found.push(...(await webSearchResults(ctx, q)));
      }
      const usableByUrl = new Map<string, { title: string; url: string; content: string }>();
      for (const r of found) {
        const url = (r.url ?? "").trim();
        if (!url.startsWith("http") || usableByUrl.has(url)) continue;
        const title = (r.title ?? "").trim();
        if (!title || /download|apk|crack|free gta|mod menu|cheat/i.test(title)) continue;
        usableByUrl.set(url, r);
      }
      const usable = [...usableByUrl.values()];
      if (usable.length > 0) {
        const resultUrls = new Set(usable.map((r) => r.url));
        const statusRank = (s: string) => (s === "Confirmed in trailer" ? 3 : s === "Reported" ? 2 : s === "Returning from GTA V" ? 1 : 0);
        let extracted: { kind: string; name: string; category: string; description: string; status: string; sourceUrl: string }[] = [];
        try {
          const extraction = await ctx.inference.complete(
            `Below are web search results about GTA VI (Grand Theft Auto VI) — official Rockstar pages and GTA news coverage. Extract ONLY database entries (vehicles, weapons, characters, locations) that a result EXPLICITLY names as being in GTA VI — a specific named car, gun, person or place, not a general article, not a category round-up with no names, not GTA V or GTA Online content. For each entry give: kind (exactly one of Vehicle, Weapon, Character, Location), name (the entry's name exactly as the result gives it, spelled correctly), category (Vehicle: its class such as Muscle, Sports, Super, Boats, Planes; Weapon: its class such as Assault Rifles, Handguns, SMGs, Shotguns, Sniper Rifles, Heavy, Melee; Character: its role — Protagonist, Supporting or Associate; Location: its kind such as Safehouse, Gun store, Mod shop, Barber, Tattoo shop, Storage facility, Clothing), description (one or two sentences in your own words from the results — what it is and where it was seen; never invent details), status (exactly one of: "Confirmed in trailer" — ONLY when a result says it clearly appears in official Rockstar trailer footage or on Rockstar's official GTA VI page; "Reported" — when GTA news coverage reports it from official material; "Unverified" — anything weaker, rumours and leaks), and sourceUrl copied EXACTLY from the result that names it. If no result clearly names a specific GTA VI entry, return an empty list. Never invent an entry, a name, a class or a confirmation that is not in the results.\n\nRESULTS:\n${usable.map((r, i) => `[${i}] ${r.title}\nURL: ${r.url}\n${cleanFoundText(r.content).slice(0, 400)}`).join("\n\n")}`,
            {
              schema: z.object({
                entries: z.array(
                  z.object({
                    kind: z.enum(["Vehicle", "Weapon", "Character", "Location"]),
                    name: z.string(),
                    category: z.string(),
                    description: z.string(),
                    status: z.enum(["Confirmed in trailer", "Reported", "Unverified"]),
                    sourceUrl: z.string(),
                  }),
                ),
              }),
            },
          );
          extracted = extraction.entries;
        } catch {
          // Inference unavailable: add nothing this run rather
          // than risk an ungrounded entry — the next scheduled
          // run tries again.
          extracted = [];
        }
        const existing = await db.select().from(schema.dbEntries);
        const byKey = new Map(existing.map((r) => [`${r.kind}:${r.name.trim().toLowerCase()}`, r]));
        for (const f of extracted) {
          const name = stripEmoji(f.name.replace(/\s+/g, " ").trim()).slice(0, 120);
          if (name.length < 2) continue;
          const sourceUrl = (f.sourceUrl ?? "").trim();
          if (!sourceUrl || !resultUrls.has(sourceUrl)) continue;
          const description = cleanFoundText(f.description ?? "").slice(0, 1200);
          if (description.length < 10) continue;
          const category = cleanFoundText(f.category ?? "").slice(0, 60);
          const key = `${f.kind}:${name.toLowerCase()}`;
          const row = byKey.get(key);
          if (!row) {
            if (added >= 6) continue;
            const [inserted] = await db.insert(schema.dbEntries).values({
              kind: f.kind as "Vehicle" | "Weapon" | "Character" | "Location",
              name,
              category,
              description,
              status: f.status as "Confirmed in trailer" | "Reported" | "Unverified",
              sourceName: hostnameOf(sourceUrl),
              sourceUrl: sourceUrl.slice(0, 500),
              featured: 0,
              type: "",
              manufacturer: "",
              drivetrain: "",
              autoDiscovered: 1,
            }).returning();
            if (inserted) byKey.set(key, inserted);
            added += 1;
            continue;
          }
          if (updated >= 8) continue;
          // Never downgrade a stronger status, and never let a
          // non-official claim overwrite an entry whose source
          // is Rockstar's own site.
          const newStatus = statusRank(f.status) >= statusRank(row.status) ? f.status : row.status;
          const existingOfficial = /rockstargames\.com/i.test(row.sourceUrl);
          const newOfficial = /rockstargames\.com/i.test(sourceUrl);
          if (existingOfficial && !newOfficial) continue;
          if (row.description === description && row.category === category && row.status === newStatus && row.sourceUrl === sourceUrl) continue;
          await db
            .update(schema.dbEntries)
            .set({
              category: category || row.category,
              description,
              status: newStatus as typeof row.status,
              sourceName: hostnameOf(sourceUrl),
              sourceUrl: sourceUrl.slice(0, 500),
              updatedAt: new Date(),
            })
            .where(eq(schema.dbEntries.id, row.id));
          updated += 1;
        }
      }
      await setMeta(ctx, "last_db_research_at", now);
      await setMeta(ctx, "last_db_sync_at", now);
      ctx.invalidateQueries();
      return { added, updated, checkedAt: now };
    },
  }),

  flagBug: defineAction({
    description: "Reports a bug post for moderation (leaks, copyrighted material, spam); three reports flag it for removal review.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      bugId: z.number().int().positive(),
      reason: z.string().trim().max(300).default(""),
    }),
    response: z.object({ reports: z.number(), flagged: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.bugReports)
        .where(
          and(
            eq(schema.bugReports.bugId, args.bugId),
            eq(schema.bugReports.reporterKey, args.playerKey),
          ),
        );
      if (!existing[0]) {
        await db.insert(schema.bugReports).values({
          bugId: args.bugId,
          reporterKey: args.playerKey,
          reason: args.reason,
        });
      }
      const all = await db
        .select()
        .from(schema.bugReports)
        .where(eq(schema.bugReports.bugId, args.bugId));
      const flagged = all.length >= 3;
      if (flagged) {
        await db.update(schema.bugs).set({ flagged: 1 }).where(eq(schema.bugs.id, args.bugId));
      }
      ctx.invalidateQueries();
      return { reports: all.length, flagged };
    },
  }),

  deleteBug: defineAction({
    description: "Removes a bug report that has been flagged by 3+ moderation reports.",
    request: z.object({ bugId: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.bugs).where(eq(schema.bugs.id, args.bugId));
      const row = rows[0];
      if (!row) throw new Error("Bug report not found.");
      if (row.flagged !== 1) {
        throw new Error("Only a bug flagged by 3+ reports can be removed this way.");
      }
      await db.delete(schema.bugs).where(eq(schema.bugs.id, args.bugId));
      await db.delete(schema.bugReports).where(eq(schema.bugReports.bugId, args.bugId));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  reportBug: defineAction({
    description: "Files a new community bug report. Signed-in accounts only — participating in the tracker needs a ViceSunshine profile.",
    request: z.object({
      title: z.string().trim().min(5).max(160),
      platform: platformEnum.default("PS5"),
      description: z.string().trim().min(10).max(2000),
      workaround: z.string().trim().max(1000).default(""),
      reporter: z.string().trim().max(40).default(""),
      playerKey: z.string().min(1).max(80),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      assertClean(args.title, args.description);
      const res = await db
        .insert(schema.bugs)
        .values({
          title: args.title,
          platform: args.platform,
          description: args.description,
          workaround: args.workaround,
          reporter: args.reporter,
          votes: 1,
        })
        .returning({ id: schema.bugs.id });
      ctx.invalidateQueries();
      return { id: res[0]?.id ?? 0 };
    },
  }),

  voteBug: defineAction({
    description: "Adds this signed-in player's 'I have this too' vote to a bug report — one vote per player per bug, enforced by a bug_votes row: voting again returns the current state without counting twice. Signed-out visitors cannot vote.",
    request: z.object({
      id: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
    }),
    response: z.object({ voted: z.boolean(), votes: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      const rows = await db.select().from(schema.bugs).where(eq(schema.bugs.id, args.id));
      const row = rows[0];
      if (!row) throw new Error("Bug report not found.");
      const existing = await db
        .select()
        .from(schema.bugVotes)
        .where(and(eq(schema.bugVotes.bugId, args.id), eq(schema.bugVotes.playerKey, args.playerKey)));
      if (existing[0]) return { voted: true, votes: row.votes };
      await db.insert(schema.bugVotes).values({ bugId: args.id, playerKey: args.playerKey });
      const votes = row.votes + 1;
      await db.update(schema.bugs).set({ votes }).where(eq(schema.bugs.id, args.id));
      ctx.invalidateQueries();
      return { voted: true, votes };
    },
  }),

  setBugStatus: defineAction({
    description: "Updates a bug's verification status (moderator action).",
    request: z.object({
      id: z.number().int().positive(),
      status: z.enum(["Reported", "Confirmed", "Investigating", "Fixed", "Cannot Reproduce"]),
      fixedIn: z.string().trim().max(30).default(""),
      workaround: z.string().trim().max(1000).default(""),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const before = await db.select().from(schema.bugs).where(eq(schema.bugs.id, args.id));
      const bug = before[0];
      await db
        .update(schema.bugs)
        .set({ status: args.status, fixedIn: args.fixedIn, workaround: args.workaround })
        .where(eq(schema.bugs.id, args.id));
      // A bug only earns Rank Points once a moderator marks it Confirmed
      // here — that moderation step IS the verification.
      if (bug && args.status === "Confirmed" && bug.status !== "Confirmed" && bug.reporter) {
        const profs = await db.select().from(schema.profiles);
        const reporter = profs.find(
          (p) => p.gamertag.toLowerCase() === bug.reporter.toLowerCase(),
        );
        if (reporter) {
          await recordPoints(ctx, {
            playerKey: reporter.playerKey,
            gamertag: reporter.gamertag,
            targetClanId: null,
            source: "bug",
            sourceRef: `bug:${bug.id}`,
            reason: `Confirmed bug report: ${bug.title}`,
            points: POINT_RATES.bug,
            verifiedBy: "ViceSunshine moderator (bug tracker)",
          });
        }
      }
      ctx.invalidateQueries();
      return ok();
    },
  }),

  listEggs: defineAction({
    description: "Lists Easter eggs and secrets with verification status.",
    request: z.object({ search: z.string().max(120).default("") }),
    response: z.object({ items: z.array(eggItem) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let rows = await db.select().from(schema.eggs).orderBy(desc(schema.eggs.id));
      const q = args.search.trim().toLowerCase();
      if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.location.toLowerCase().includes(q));
      return {
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          location: r.location,
          howTo: r.howTo,
          status: r.status,
          x: r.x,
          y: r.y,
          sourceName: r.sourceName,
          sourceUrl: r.sourceUrl,
        })),
      };
    },
  }),

  addEgg: defineAction({
    description: "Submits a new Easter egg or secret for community verification. Location is an approximate region only — no exact map pin is created, because the official map is not released and no location is verified until after launch.",
    request: z.object({
      name: z.string().trim().min(3).max(120),
      location: z.string().trim().max(120).default(""),
      howTo: z.string().trim().max(1500).default(""),
      status: z.enum(["Confirmed", "Reported", "Rumor"]).default("Reported"),
      x: z.number().min(2).max(98).default(50),
      y: z.number().min(2).max(98).default(50),
      playerKey: z.string().max(80).default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      assertClean(args.name, args.location, args.howTo);
      // Store the find as a list entry only. Deliberately do NOT create a
      // map pin: the official map is not released yet and exact in-game
      // locations are unverified until after launch on Nov 19, 2026.
      // New finds can never start as Confirmed — verification comes later.
      const { playerKey, ...rest } = args;
      const res = await db
        .insert(schema.eggs)
        .values({ ...rest, status: rest.status === "Confirmed" ? "Reported" : rest.status, submitterKey: playerKey })
        .returning({ id: schema.eggs.id });
      if (playerKey) {
      }
      ctx.invalidateQueries();
      return { id: res[0]?.id ?? 0 };
    },
  }),

  setEggStatus: defineAction({
    description: "Changes an Easter egg's verification status.",
    request: z.object({
      id: z.number().int().positive(),
      status: z.enum(["Confirmed", "Reported", "Rumor"]),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const before = await db.select().from(schema.eggs).where(eq(schema.eggs.id, args.id));
      const egg = before[0];
      await db.update(schema.eggs).set({ status: args.status }).where(eq(schema.eggs.id, args.id));
      // An egg only earns Rank Points once a moderator verifies it here,
      // and only for the player who submitted it (with proof in the
      // claim flow). Legacy finds with no submitter earn nothing.
      if (egg && args.status === "Confirmed" && egg.status !== "Confirmed" && egg.submitterKey) {
        const profs = await db
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.playerKey, egg.submitterKey));
        const submitter = profs[0];
        if (submitter) {
          await recordPoints(ctx, {
            playerKey: submitter.playerKey,
            gamertag: submitter.gamertag,
            targetClanId: null,
            source: "egg",
            sourceRef: `egg:${egg.id}`,
            reason: `Verified Easter egg find: ${egg.name}`,
            points: POINT_RATES.egg,
            verifiedBy: "ViceSunshine moderator (Easter Eggs)",
          });
        }
      }
      ctx.invalidateQueries();
      return ok();
    },
  }),

  getEggDetail: defineAction({
    description: "Returns one Easter egg's full detail tab: the egg itself, its automatically gathered videos / guides / articles, related Community Feed posts and guides, and other eggs to try next.",
    request: z.object({
      id: z.number().int().positive(),
      playerKey: z.string().max(80).default(""),
    }),
    response: z.object({
      egg: eggItem.nullable(),
      media: z.array(
        z.object({
          id: z.number(),
          kind: z.string(),
          title: z.string(),
          url: z.string(),
          sourceName: z.string(),
          mediaType: z.string(),
          embedUrl: z.string(),
          videoId: z.string(),
          createdAt: z.string(),
        }),
      ),
      relatedPosts: z.array(
        z.object({
          id: z.number(),
          author: z.string(),
          kind: z.string(),
          title: z.string(),
          body: z.string(),
          mediaUrl: z.string(),
          mediaType: z.string(),
          embedUrl: z.string(),
          videoId: z.string(),
          sourceName: z.string(),
          sourceUrl: z.string(),
          auto: z.boolean(),
          createdAt: z.string(),
        }),
      ),
      relatedGuides: z.array(
        z.object({
          id: z.number(),
          title: z.string(),
          category: z.string(),
          body: z.string(),
          author: z.string(),
        }),
      ),
      moreEggs: z.array(eggItem),
      lastRefreshedAt: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const eggRows = await db.select().from(schema.eggs).where(eq(schema.eggs.id, args.id));
      const egg = eggRows[0];
      if (!egg) {
        return { egg: null, media: [], relatedPosts: [], relatedGuides: [], moreEggs: [], lastRefreshedAt: "" };
      }
      const keywords = eggKeywords(egg.name);
      const mediaRows = await db
        .select()
        .from(schema.eggMedia)
        .where(eq(schema.eggMedia.eggId, egg.id))
        .orderBy(desc(schema.eggMedia.id));
      // Related Feed posts: anything the community (or the automatic
      // Feed refresh) posted about this specific find — matched on
      // the egg's name / distinctive words, never a generic list.
      const feedRows = await db.select().from(schema.feedPosts).orderBy(desc(schema.feedPosts.id));
      const relatedPosts = feedRows
        .filter((r) => r.flagged !== 1)
        .filter((r) => textMatchesEgg(`${r.title} ${r.body}`, egg.name, keywords))
        .slice(0, 6)
        .map((r) => ({
          id: r.id,
          author: r.author,
          kind: r.kind,
          title: r.title,
          body: r.body,
          mediaUrl: r.mediaUrl,
          ...feedMediaOf(r.mediaUrl),
          sourceName: r.sourceName,
          sourceUrl: r.sourceUrl,
          auto: r.auto === 1,
          createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt ?? ""),
        }));
      const guideRows = await db.select().from(schema.guides).orderBy(desc(schema.guides.id));
      const relatedGuides = guideRows
        .filter((g) => textMatchesEgg(`${g.title} ${g.body}`, egg.name, keywords))
        .slice(0, 4)
        .map((g) => ({ id: g.id, title: g.title, category: g.category, body: g.body, author: g.author }));
      const otherEggs = await db.select().from(schema.eggs).orderBy(desc(schema.eggs.id));
      const moreEggs = otherEggs
        .filter((e) => e.id !== egg.id)
        .slice(0, 4)
        .map((r) => ({
          id: r.id,
          name: r.name,
          location: r.location,
          howTo: r.howTo,
          status: r.status,
          x: r.x,
          y: r.y,
          sourceName: r.sourceName,
          sourceUrl: r.sourceUrl,
        }));
      return {
        egg: {
          id: egg.id,
          name: egg.name,
          location: egg.location,
          howTo: egg.howTo,
          status: egg.status,
          x: egg.x,
          y: egg.y,
          sourceName: egg.sourceName,
          sourceUrl: egg.sourceUrl,
        },
        media: mediaRows.map((m) => ({
          id: m.id,
          kind: m.kind,
          title: m.title,
          url: m.url,
          sourceName: m.sourceName,
          ...feedMediaOf(m.url),
          createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt ?? ""),
        })),
        relatedPosts,
        relatedGuides,
        moreEggs,
        lastRefreshedAt: await getMeta(ctx, `egg_refreshed:${egg.id}`),
      };
    },
  }),

  refreshEggContent: defineAction({
    description: "Automatic Easter egg refresh: searches the web for new videos, guides and articles about each egg and stores them on that egg's detail tab, and (on a full run) discovers newly reported GTA VI Easter eggs online and adds them as Rumor finds with their source. Runs on a schedule and when an egg's tab is opened with stale content — nobody has to add anything by hand.",
    request: z.object({ eggId: z.number().int().positive().optional() }),
    response: z.object({ addedEggs: z.number(), addedMedia: z.number(), checkedAt: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let addedEggs = 0;
      let addedMedia = 0;
      const now = new Date().toISOString();

      // ---- Discovery pass (full runs only): new finds reported
      // online become new eggs automatically. Extraction is grounded
      // strictly in the search results handed to the model — a find
      // is only stored when a result actually describes it, its
      // source URL must be one of those results, and it always
      // starts as Rumor with the source recorded.
      if (!args.eggId) {
        const discoveryQueries = [
          "GTA VI Grand Theft Auto VI easter eggs secrets discovered",
          "GTA VI hidden easter egg found players report Leonida",
        ];
        const found: { title: string; url: string; content: string }[] = [];
        for (const q of discoveryQueries) {
          found.push(...(await webSearchResults(ctx, q)));
        }
        const usable = found.filter(
          (r) => r.url.startsWith("http") && r.title && !/download|apk|crack|free gta|mod menu/i.test(r.title),
        );
        if (usable.length > 0) {
          try {
            const extraction = await ctx.inference.complete(
              `Below are web search results about GTA VI Easter eggs and secrets. Extract ONLY distinct, specific Easter egg / secret finds that a result explicitly describes (a named thing players found or reported — not general articles, not lists of tips, not the game itself). For each find give: name (short, the find itself, e.g. "Sunken statue off the Keys"), location (the approximate in-game region ONLY if a result states one, otherwise ""), howTo (one or two sentences from the results on what it is / how to find it, in your own words), and sourceUrl copied EXACTLY from the result that describes it. If no result clearly describes a specific find, return an empty list. Never invent a find, a location or a detail that is not in the results.\n\nRESULTS:\n${usable.map((r, i) => `[${i}] ${r.title}\nURL: ${r.url}\n${cleanFoundText(r.content).slice(0, 400)}`).join("\n\n")}`,
              {
                schema: z.object({
                  finds: z.array(
                    z.object({
                      name: z.string(),
                      location: z.string(),
                      howTo: z.string(),
                      sourceUrl: z.string(),
                    }),
                  ),
                }),
              },
            );
            const existingEggs = await db.select().from(schema.eggs);
            const seenNames = new Set(existingEggs.map((e) => e.name.trim().toLowerCase()));
            const resultUrls = new Set(usable.map((r) => r.url));
            for (const f of extraction.finds) {
              if (addedEggs >= 3) break;
              const name = stripEmoji(f.name.replace(/\s+/g, " ").trim()).slice(0, 120);
              if (name.length < 4) continue;
              const lower = name.toLowerCase();
              // Dedupe: exact name, or one name containing the other
              // (e.g. "Vercetti Estate" vs "Vercetti Estate references").
              const dupe = [...seenNames].some(
                (n) => n === lower || (lower.length >= 8 && n.includes(lower)) || (n.length >= 8 && lower.includes(n)),
              );
              if (dupe) continue;
              const src = resultUrls.has(f.sourceUrl) ? usable.find((r) => r.url === f.sourceUrl) : undefined;
              seenNames.add(lower);
              await db.insert(schema.eggs).values({
                name,
                location: stripEmoji(f.location.replace(/\s+/g, " ").trim()).slice(0, 120),
                howTo: cleanFoundText(f.howTo).slice(0, 1500),
                status: "Rumor",
                sourceName: src ? hostnameOf(src.url) : "",
                sourceUrl: src ? src.url.slice(0, 500) : "",
              });
              addedEggs += 1;
            }
          } catch {
            // Inference unavailable: discovery is skipped this run;
            // the per-egg media refresh below still runs.
          }
        }
      }

      // ---- Per-egg media pass: new videos / guides / articles for
      // each egg, stored on that egg's own tab. A single-egg run
      // (tab opened with stale content) refreshes just that egg; a
      // full run refreshes the stalest eggs first, capped per run.
      const allEggs = await db.select().from(schema.eggs).orderBy(desc(schema.eggs.id));
      let targets = allEggs;
      if (args.eggId) {
        targets = allEggs.filter((e) => e.id === args.eggId);
      } else {
        const stamps = new Map<string, string>();
        for (const e of allEggs) stamps.set(String(e.id), await getMeta(ctx, `egg_refreshed:${e.id}`));
        targets = [...allEggs]
          .sort((a, b) => (stamps.get(String(a.id)) ?? "").localeCompare(stamps.get(String(b.id)) ?? ""))
          .slice(0, 6);
      }
      for (const egg of targets) {
        const existingMedia = await db
          .select()
          .from(schema.eggMedia)
          .where(eq(schema.eggMedia.eggId, egg.id));
        const seenUrls = new Set(existingMedia.map((m) => m.url));
        const seenVideoIds = new Set(existingMedia.map((m) => youtubeIdOf(m.url)).filter(Boolean));
        let eggAdded = 0;
        // Videos about this specific egg.
        const videoResults = await webSearchResults(
          ctx,
          `site:youtube.com GTA VI "${egg.name}" easter egg`,
        );
        for (const r of videoResults) {
          if (eggAdded >= 4 || addedMedia >= 24) break;
          const title = stripEmoji((r.title ?? "").replace(/\s+/g, " ").trim());
          if (!title || /leak|download|apk|crack|free gta|mod menu/i.test(title)) continue;
          const direct = (r.url ?? "").trim();
          let videoUrl = youtubeIdOf(direct) ? direct : "";
          if (!videoUrl) {
            const embedded = (r.content ?? "").match(
              /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?[^\s"'<>)\]]+|shorts\/[A-Za-z0-9_-]{6,20})|youtu\.be\/[A-Za-z0-9_-]{6,20})/,
            );
            if (embedded?.[0] && youtubeIdOf(embedded[0])) videoUrl = embedded[0];
          }
          const vid = youtubeIdOf(videoUrl);
          if (!vid || seenVideoIds.has(vid) || seenUrls.has(videoUrl)) continue;
          // Never store a video YouTube says is gone or unembeddable.
          if (!(await youtubeEmbeddable(vid))) continue;
          seenVideoIds.add(vid);
          seenUrls.add(videoUrl);
          await db.insert(schema.eggMedia).values({
            eggId: egg.id,
            kind: "Video",
            title: title.slice(0, 200),
            url: videoUrl.slice(0, 500),
            sourceName: "YouTube",
          });
          eggAdded += 1;
          addedMedia += 1;
        }
        // Written guides / articles about this specific egg.
        const articleResults = await webSearchResults(ctx, `GTA VI ${egg.name} easter egg guide`);
        let articlesAdded = 0;
        for (const r of articleResults) {
          if (articlesAdded >= 3 || addedMedia >= 24) break;
          const url = (r.url ?? "").trim();
          const title = stripEmoji((r.title ?? "").replace(/\s+/g, " ").trim());
          if (!url.startsWith("http") || !title) continue;
          if (youtubeIdOf(url) || seenUrls.has(url)) continue;
          if (/leak|download|apk|crack|free gta|mod menu/i.test(title)) continue;
          // The article must actually be about THIS egg.
          if (!textMatchesEgg(`${title} ${r.content}`, egg.name, eggKeywords(egg.name))) continue;
          seenUrls.add(url);
          await db.insert(schema.eggMedia).values({
            eggId: egg.id,
            kind: /guide|how to|where to find|location/i.test(title) ? "Guide" : "Article",
            title: title.slice(0, 200),
            url: url.slice(0, 500),
            sourceName: hostnameOf(url),
          });
          articlesAdded += 1;
          addedMedia += 1;
        }
        await setMeta(ctx, `egg_refreshed:${egg.id}`, now);
      }
      await setMeta(ctx, "eggs_last_refresh", now);
      ctx.invalidateQueries();
      return { addedEggs, addedMedia, checkedAt: now };
    },
  }),

  listPins: defineAction({
    description: "Lists verified map pins. Returns none before launch: the official GTA VI map is not released yet, so no pin location is verified until after Nov 19, 2026.",
    request: z.object({ layer: z.string().max(30).default("All") }),
    response: z.object({ items: z.array(pinItem) }),
    async handler() {
      // Honest pre-launch state: seeded/legacy pin rows claimed precise
      // in-game positions that cannot be verified yet, so they are not
      // served. Verified pins will be served here after launch.
      return { items: [] };
    },
  }),

  addPin: defineAction({
    description: "Adds a verified pin to the interactive Leonida map. Disabled until after launch, when locations can be verified in-game.",
    request: z.object({
      name: z.string().trim().min(2).max(120),
      layer: z
        .enum(["Missions", "Easter Eggs", "Collectibles", "Activities", "Shops", "Safehouses"])
        .default("Activities"),
      detail: z.string().trim().max(600).default(""),
      x: z.number().min(2).max(98),
      y: z.number().min(2).max(98),
    }),
    response: z.object({ id: z.number() }),
    async handler() {
      throw new Error(
        "Map pins are not available yet — the official map has not been released, and locations can only be verified after launch on Nov 19, 2026.",
      );
    },
  }),

  listGuides: defineAction({
    description: "Lists guides, optionally filtered by category or search.",
    request: z.object({
      category: z.string().max(40).default("All"),
      search: z.string().max(120).default(""),
    }),
    response: z.object({ items: z.array(guideItem) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let rows = await db.select().from(schema.guides).orderBy(desc(schema.guides.id));
      if (args.category !== "All") rows = rows.filter((r) => r.category === args.category);
      const q = args.search.trim().toLowerCase();
      if (q) rows = rows.filter((r) => r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q));
      return {
        items: rows.map((r) => ({
          id: r.id,
          title: r.title,
          category: r.category,
          body: r.body,
          author: r.author,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  getCodeHowTos: defineAction({
    description: "Automatic how-to links for GTA 6 codes: for each code name given, finds any real related video, guide or post about that exact code — automatic/community Feed posts that carry a source or video URL, and in-app Guides — so a code gains its how-to video/guide on its own as soon as someone posts one, including the moment an unverified code is released and verified. Returns only codes that have at least one link; nothing is invented.",
    request: z.object({
      names: z.array(z.string().trim().min(1).max(80)).max(80),
    }),
    response: codeHowTosResponse,
    async handler(ctx, args): Promise<z.infer<typeof codeHowTosResponse>> {
      const db = ctx.db<typeof schema>();
      const CODE_CONTEXT = ["code", "cheat", "unlock", "combo", "d-pad", "dpad", "how to", "guide"];
      // ANY related video / guide / post about that exact code
      // counts — the code's full name must be in it. Distinctive
      // names (longer, multi-word, or numbered) match on the name
      // alone; short everyday names ("Drunk", "Pinhole") also need
      // one code-ish word alongside, so unrelated posts that merely
      // use the same word don't attach by accident.
      const aboutCode = (text: string, name: string, kind: string) => {
        const t = text.toLowerCase();
        const n = name.toLowerCase();
        if (!t.includes(n)) return false;
        if (n.length >= 7 || /[\s\d$]/.test(n)) return true;
        return kind === "Tutorial" || t.includes("gta") || CODE_CONTEXT.some((w) => t.includes(w));
      };
      const feedRows = await db.select().from(schema.feedPosts).orderBy(desc(schema.feedPosts.id));
      const guideRows = await db.select().from(schema.guides).orderBy(desc(schema.guides.id));
      const items: z.infer<typeof codeHowTosResponse>["items"] = [];
      for (const name of args.names) {
        const links: z.infer<typeof codeHowTosResponse>["items"][number]["links"] = [];
        for (const r of feedRows) {
          if (links.length >= 2) break;
          if (r.flagged === 1 || r.repostOfId !== 0) continue;
          if (!aboutCode(`${r.title} ${r.body}`, name, r.kind)) continue;
          const media = feedMediaOf(r.mediaUrl);
          const url = r.sourceUrl || (media.mediaType === "youtube" || media.mediaType === "video" ? r.mediaUrl : "");
          if (!/^https?:\/\//i.test(url)) continue;
          const kind = feedMediaOf(url).mediaType === "youtube" || feedMediaOf(url).mediaType === "video" ? "video" as const : "article" as const;
          links.push({ kind, title: r.title || r.body.slice(0, 80), url, sourceName: r.sourceName || hostnameOf(url), guideId: 0, guideCategory: "" });
        }
        for (const g of guideRows) {
          if (links.length >= 2) break;
          if (!aboutCode(`${g.title} ${g.body}`, name, "")) continue;
          links.push({ kind: "guide" as const, title: g.title, url: "", sourceName: g.author ? `Guide by ${g.author}` : "ViceSunshine guide", guideId: g.id, guideCategory: g.category });
        }
        const rank = { video: 0, guide: 1, article: 2 } as const;
        links.sort((a, b) => rank[a.kind] - rank[b.kind]);
        if (links.length > 0) items.push({ codeName: name, links });
      }
      return { items };
    },
  }),

  addGuide: defineAction({
    description: "Publishes a community guide.",
    request: z.object({
      title: z.string().trim().min(5).max(160),
      category: z.string().trim().min(2).max(40).default("Beginner"),
      body: z.string().trim().min(20).max(6000),
      author: z.string().trim().max(40).default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      assertClean(args.title, args.body);
      const res = await db.insert(schema.guides).values(args).returning({ id: schema.guides.id });
      ctx.invalidateQueries();
      return { id: res[0]?.id ?? 0 };
    },
  }),

  getProfile: defineAction({
    description: "Returns the player's own profile for this device key, if one exists — including the Discord-style profile fields only the owner sees (private note, member-since date) and their friends (crewmates). The private note is only ever returned for the requesting player's own key.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({
      isOwner: z.boolean(),
      profile: z
        .object({
          gamertag: z.string(),
          displayName: z.string(),
          bio: z.string(),
          location: z.string(),
          website: z.string(),
          dob: z.string(),
          ownClanTag: z.string(),
          profilePrivate: z.boolean(),
          showClan: z.boolean(),
          memberSince: z.string(),
          privateNote: z.string(),
          platform: z.string(),
          region: z.string(),
          playstyle: z.string(),
          reputation: z.number(),
          premium: z.boolean(),
          psnId: z.string(),
          xboxId: z.string(),
          rockstarId: z.string(),
          discordId: z.string(),
          others: z.array(z.object({ label: z.string(), url: z.string() })),
          showPsn: z.boolean(),
          showXbox: z.boolean(),
          showRockstar: z.boolean(),
          showDiscord: z.boolean(),
          showOther: z.boolean(),
          credits: z.number(),
          badge: z.string(),
          bannerColor: z.string(),
          nameColor: z.string(),
          themeAccent: z.string(),
          avatarFrame: z.string(),
          avatarId: z.string(),
          avatarUrl: z.string(),
          avatarEffect: z.string(),
          hasCustomAvatar: z.boolean(),
          bannerMediaUrl: z.string(),
          bannerMediaType: z.string(),
          customStatus: z.string(),
          callingCard: z.string(),
          presence: z.string(),
          presenceStatus: z.string(),
          vicePoints: z.number(),
          viceLevel: z.number(),
          premiumWeeklyNext: z.string(),
          eventsAttended: z.number(),
          clanId: z.number(),
          clanName: z.string(),
          clanTag: z.string(),
          clanRole: z.string(),
          clanColor: z.string(),
          clanEmblem: z.string(),
          clanWarsWon: z.number(),
          seasonRank: z.number(),
          totalClans: z.number(),
          topPercent: z.number(),
          inVoice: z.boolean(),
          friends: z.array(
            z.object({
              playerKey: z.string(),
              gamertag: z.string(),
              role: z.string(),
              platform: z.string(),
              avatarFrame: z.string(),
              avatarUrl: z.string(),
              avatarEffect: z.string(),
              presence: z.string(),
              nameColor: z.string(),
              inVoice: z.boolean(),
            }),
          ),
        })
        .nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const r = rows[0];
      if (!r) return { profile: null, isOwner: false };
      // Opening your profile is activity: refresh the presence
      // heartbeat so friends, clanmates and LFG see you as present
      // (with whatever status you chose — Ghost still reads Offline
      // to them).
      await touchPresence(ctx, args.playerKey);
      // Explain the starting balance once in the transaction history for
      // profiles created before the credits system existed.
      const txs = await db
        .select()
        .from(schema.creditTransactions)
        .where(eq(schema.creditTransactions.ownerId, args.playerKey));
      if (!txs.some((t) => t.reason.startsWith("Welcome"))) {
        await logCredit(
          ctx,
          "personal",
          args.playerKey,
          args.playerKey,
          STARTING_CREDITS,
          "Welcome — your starting Vice Credits",
        );
      }
      const premiumState = await applyPremiumWeeklyCredits(ctx, args.playerKey);
      const freshRows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const fr = freshRows[0] ?? r;
      const events = await db.select().from(schema.rankPointEvents);
      const vicePoints = personalPointsOf(events, args.playerKey);
      // Level milestone rewards pay out on read, like Premium weekly
      // credits — re-read the balance afterwards so it includes them.
      await applyLevelMilestoneCredits(ctx, args.playerKey, playerLevelFromPoints(vicePoints).level);
      const postMilestoneRows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const creditsNow = postMilestoneRows[0]?.credits ?? fr.credits;
      // Tracker-style community stats — all counted from ViceSunshine's
      // own records (RSVPs, events attended), never from the
      // game itself.
      const myRsvps = await db.select().from(schema.rsvps).where(eq(schema.rsvps.playerKey, args.playerKey));
      const eventsAttended = myRsvps.filter((x) => x.status === "Going").length;
      const myMemberships = await db
        .select()
        .from(schema.clanMembers)
        .where(eq(schema.clanMembers.playerKey, args.playerKey));
      const myClanId = myMemberships[0]?.clanId ?? 0;
      const myClanRole = myMemberships[0]?.role ?? "";
      let clanName = "";
      let clanTag = "";
      let clanColor = "";
      let clanEmblem = "";
      let clanWarsWon = 0;
      let seasonRank = 0;
      let totalClans = 0;
      let topPercent = 0;
      // Friends on ViceSunshine are your clanmates — the people you
      // actually play and post with here. Derived from real clan
      // membership rows only; nobody is invented.
      let friends: {
        playerKey: string; gamertag: string; role: string; platform: string;
        avatarFrame: string; avatarUrl: string; avatarEffect: string; presence: string; nameColor: string; inVoice: boolean;
      }[] = [];
      if (myClanId) {
        const clanRows = await db.select().from(schema.clans).where(eq(schema.clans.id, myClanId));
        clanName = clanRows[0]?.name ?? "";
        clanTag = clanRows[0]?.tag ?? "";
        clanColor = clanRows[0]?.color ?? "";
        clanEmblem = clanRows[0]?.emblem ?? "";
        clanWarsWon = 0;
        const stats = await computeClanRankStats(ctx, seasonKeyOf(new Date()));
        totalClans = stats.size;
        seasonRank = seasonRankMap(stats).get(myClanId) ?? 0;
        if (seasonRank > 0 && totalClans > 0) {
          topPercent = Math.max(1, Math.ceil((seasonRank / totalClans) * 100));
        }
        const mates = await db
          .select()
          .from(schema.clanMembers)
          .where(eq(schema.clanMembers.clanId, myClanId));
        if (mates.some((m) => m.playerKey !== args.playerKey)) {
          const allProfs = await db.select().from(schema.profiles);
          const byKey = new Map(allProfs.map((p) => [p.playerKey, p]));
          const art = await avatarArtUrls(ctx);
          const customArt = await customAvatarUrls(ctx);
          friends = mates
            .filter((m) => m.playerKey !== args.playerKey)
            .map((m) => {
              const p = byKey.get(m.playerKey);
              return {
                playerKey: m.playerKey,
                gamertag: m.gamertag,
                role: m.role,
                platform: p?.platform ?? m.platform,
                avatarFrame: "",
                avatarUrl: p ? pickAvatar(art, customArt, p) : "",
                avatarEffect: p?.avatarEffect ?? "",
                presence: p ? effectivePresence(p, args.playerKey) : "Offline",
                nameColor: "",
                inVoice: false,
              };
            });
        }
      }
      let others: { label: string; url: string }[] = [];
      try {
        const parsed = JSON.parse(r.otherLinks || "[]") as { label?: string; url?: string }[];
        if (Array.isArray(parsed)) {
          others = parsed
            .filter((o) => o.label && o.url)
            .map((o) => ({ label: String(o.label), url: String(o.url) }));
        }
      } catch {
        others = [];
      }
      const ownerRow = await ownerProfileRow(ctx);
      return {
        isOwner: ownerRow?.playerKey === args.playerKey,
        profile: {
          gamertag: r.gamertag,
          displayName: r.displayName,
          bio: r.bio,
          location: r.location,
          website: r.website,
          dob: r.dob,
          ownClanTag: r.clanTag,
          profilePrivate: r.profilePrivate === 1,
          showClan: r.showClan === 1,
          memberSince: r.createdAt.toISOString(),
          privateNote: r.privateNote,
          platform: r.platform,
          region: r.region,
          playstyle: r.playstyle,
          reputation: r.reputation,
          premium: r.premium === 1,
          psnId: r.psnId,
          xboxId: r.xboxId,
          rockstarId: r.rockstarId,
          discordId: r.discordId,
          others,
          showPsn: r.showPsn === 1,
          showXbox: r.showXbox === 1,
          showRockstar: r.showRockstar === 1,
          showDiscord: r.showDiscord === 1,
          showOther: r.showOther === 1,
          credits: creditsNow,
          badge: r.badge,
          // Banner colours are gone — the calling card is the banner.
          bannerColor: "",
          nameColor: "",
          themeAccent: r.themeAccent,
          avatarFrame: "",
          avatarId: r.avatarId,
          avatarUrl: await profileAvatarUrl(ctx, await avatarArtUrls(ctx), r),
          avatarEffect: r.avatarEffect,
          hasCustomAvatar: Boolean(r.customAvatarBlobKey),
          bannerMediaUrl: await profileBannerUrl(ctx, r),
          bannerMediaType: r.bannerBlobKey ? r.bannerMediaType : "",
          customStatus: r.customStatus ?? "",
          callingCard: r.callingCard,
          presence: r.presence || "Online",
          presenceStatus: effectivePresence(r, args.playerKey),
          vicePoints,
          viceLevel: playerLevelFromPoints(vicePoints).level,
          premiumWeeklyNext: premiumState.active ? premiumState.nextPayoutAt : "",
          eventsAttended,
          clanId: myClanId,
          clanName,
          clanTag,
          clanRole: myClanRole,
          clanColor,
          clanEmblem,
          clanWarsWon,
          seasonRank,
          totalClans,
          topPercent,
          inVoice: false,
          friends,
        },
      };
    },
  }),

  saveProfileNote: defineAction({
    description: "Saves the player's private profile note. The note is only visible to its owner — it is stored on their own profile row and only ever returned by getProfile for that same player key.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      note: z.string().trim().max(500).default(""),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const p = rows[0];
      if (!p) throw new Error("Create your profile first — then you can add a private note to it.");
      await db.update(schema.profiles).set({ privateNote: args.note }).where(eq(schema.profiles.id, p.id));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  checkUsername: defineAction({
    description: "Live username check for sign-up and renames: every ViceSunshine username is unique (trimmed, case-insensitive), so this reports whether a name is free before the player tries to save it.",
    request: z.object({
      username: z.string().trim().max(32).default(""),
      playerKey: z.string().max(80).default(""),
    }),
    response: z.object({ available: z.boolean(), message: z.string() }),
    async handler(ctx, args): Promise<{ available: boolean; message: string }> {
      const name = args.username.trim();
      if (name.length < 2) return { available: false, message: "Usernames need at least 2 characters." };
      const reason = screenText(name);
      if (reason) return { available: false, message: `That username isn't allowed: ${reason}.` };
      const db = ctx.db<typeof schema>();
      const norm = name.toLowerCase();
      const all = await db
        .select({ playerKey: schema.profiles.playerKey, gamertag: schema.profiles.gamertag })
        .from(schema.profiles);
      const taken = all.some((p) => p.playerKey !== args.playerKey && p.gamertag.trim().toLowerCase() === norm);
      return taken
        ? { available: false, message: "That username is already taken — every username is different, so pick another one." }
        : { available: true, message: "That username is available." };
    },
  }),

  checkEmail: defineAction({
    description: "Live email check for the sign-up Gmail step and Settings: validates the Gmail shape AND that no other ViceSunshine account already uses it — one account per Gmail, so a used email blocks the step before the player goes any further.",
    request: z.object({
      email: z.string().trim().max(120).default(""),
      playerKey: z.string().max(80).default(""),
    }),
    response: z.object({ available: z.boolean(), status: z.enum(["available", "taken", "invalid"]), message: z.string() }),
    async handler(ctx, args): Promise<{ available: boolean; status: "available" | "taken" | "invalid"; message: string }> {
      const email = args.email.trim();
      if (!email) return { available: false, status: "invalid" as const, message: "Enter your Gmail address." };
      try {
        assertGmailEmail(email);
      } catch (e) {
        return { available: false, status: "invalid" as const, message: e instanceof Error ? e.message : "That email isn't valid." };
      }
      const db = ctx.db<typeof schema>();
      const norm = email.toLowerCase();
      const all = await db
        .select({ playerKey: schema.profiles.playerKey, email: schema.profiles.email })
        .from(schema.profiles);
      const taken = all.some((p) => p.playerKey !== args.playerKey && p.email.trim().toLowerCase() === norm);
      return taken
        ? { available: false, status: "taken" as const, message: "That Gmail already has a ViceSunshine account — one account per Gmail. Log in instead, or use a different Gmail." }
        : { available: true, status: "available" as const, message: "That Gmail is free to use." };
    },
  }),

  requestEmailCode: defineAction({
    description: "Automatically emails a 6-digit code to a Gmail address — used by the sign-in gate's VERIFY YOUR EMAIL sign-up step (TRN flow: email → CREATE NEW ACCOUNT? → Create New → this code is emailed → verifySignupCode checks it → then username and password → createAccount) and by Settings to confirm an account's email. The email is sent automatically from the official ViceSunshine Gmail (officialvicesunshine@gmail.com) via a single direct Resend API call, sent the moment the code is issued so it arrives immediately — with the subject \"Welcome to ViceSunshine! Here is your registration code!\" and the code in big separate boxes — no manual sending. The code is stored only as a hash, lives 1 minute, and a new one can be requested after 20 seconds.",
    request: z.object({
      email: z.string().trim().min(3).max(120),
      playerKey: z.string().max(80).default(""),
    }),
    response: z.object({ sent: z.boolean(), message: z.string() }),
    async handler(ctx, args): Promise<{ sent: boolean; message: string }> {
      assertGmailEmail(args.email);
      // The email must be free (or already this player's own) —
      // confirming an address another account uses is never allowed.
      await assertEmailAvailable(ctx, args.email, args.playerKey);
      if (await emailCodeSentRecently(ctx, args.email, "verify")) {
        return { sent: false, message: "A code was just sent to that Gmail — give it a few seconds, check your inbox (and spam), then tap Resend if it doesn't arrive." };
      }
      const code = await issueEmailCode(ctx, args.email, "verify");
      await deliverEmailCode(ctx, args.email, "verify", code);
      return { sent: true, message: `A 6-digit code is on its way to ${args.email.trim()} — enter it within 1 minute to confirm your email.` };
    },
  }),

  verifyEmailCode: defineAction({
    description: "Checks a 6-digit email confirmation code for the signed-in player's own account email and, when it matches, marks the account's email as verified. Wrong or expired codes fail with a clear message; 5 wrong tries kill the code.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      code: z.string().trim().min(4).max(8),
    }),
    response: z.object({ verified: z.boolean(), message: z.string() }),
    async handler(ctx, args): Promise<{ verified: boolean; message: string }> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const me = rows[0];
      if (!me || !me.email) throw new Error("Create your account first — then you can confirm its email.");
      const okCode = await consumeEmailCode(ctx, me.email, "verify", args.code);
      if (!okCode) {
        return { verified: false, message: "That code isn't right, or it has expired — request a fresh code and try again." };
      }
      await db
        .update(schema.profiles)
        .set({ emailVerified: 1 })
        .where(eq(schema.profiles.id, me.id));
      ctx.invalidateQueries();
      return { verified: true, message: "Email confirmed — this Gmail is now verified on your account." };
    },
  }),

  requestPasswordReset: defineAction({
    description: "Starts Forgot password: automatically emails a 6-digit reset code to the account's Gmail from the official ViceSunshine Gmail (officialvicesunshine@gmail.com) via a single direct Resend API call — no manual sending (only when an account with that email exists — the response is the same either way, so it never reveals which emails have accounts). The code lives 1 minute and is stored only as a hash.",
    request: z.object({ email: z.string().trim().min(3).max(120) }),
    response: z.object({ sent: z.boolean(), message: z.string() }),
    async handler(ctx, args): Promise<{ sent: boolean; message: string }> {
      const message = "If a ViceSunshine account uses that Gmail, a 6-digit reset code is on its way — enter it within 1 minute to set a new password.";
      const db = ctx.db<typeof schema>();
      const norm = args.email.trim().toLowerCase();
      const all = await db.select().from(schema.profiles);
      const me = all.find((p) => p.email.trim().toLowerCase() === norm && p.email.trim() !== "");
      if (!me) return { sent: false, message };
      if (await emailCodeSentRecently(ctx, args.email, "reset")) return { sent: false, message };
      const code = await issueEmailCode(ctx, args.email, "reset");
      await deliverEmailCode(ctx, args.email, "reset", code);
      return { sent: true, message };
    },
  }),

  verifyResetCode: defineAction({
    description: "Step 2 of Forgot password (owner's direction): checks the emailed 6-digit reset code on its own — six boxes, one digit each — and, when it is right, the page moves to the new-password step. Checking does NOT consume the code (it is consumed by resetPassword when the new password is set); wrong guesses count toward the same 5-attempt limit, and the response never reveals whether the email has an account.",
    request: z.object({
      email: z.string().trim().min(3).max(120),
      code: z.string().trim().min(4).max(8),
    }),
    response: z.object({ valid: z.boolean(), message: z.string() }),
    async handler(ctx, args): Promise<{ valid: boolean; message: string }> {
      const db = ctx.db<typeof schema>();
      const norm = args.email.trim().toLowerCase();
      const all = await db.select().from(schema.profiles);
      const me = all.find((p) => p.email.trim().toLowerCase() === norm && p.email.trim() !== "");
      if (!me) return { valid: false, message: "That code isn't right, or it has expired — request a fresh code and try again." };
      const okCode = await peekEmailCode(ctx, args.email, "reset", args.code);
      if (!okCode) return { valid: false, message: "That code isn't right, or it has expired — request a fresh code and try again." };
      return { valid: true, message: "Code accepted — now choose your new password." };
    },
  }),

  checkGateCode: defineAction({
    description: "Checks a 6-digit emailed code (purpose \"verify\" or \"login\") without consuming it. The sign-up gate does NOT use this — its VERIFY YOUR EMAIL step uses verifySignupCode, which consumes the code and issues the signup proof createAccount requires. This stays available as a non-consuming code check. Wrong guesses count toward the same 5-attempt limit as every other code check, and expired codes fail.",
    request: z.object({
      email: z.string().trim().min(3).max(120),
      code: z.string().trim().min(4).max(8),
      purpose: z.enum(["verify", "login"]).default("verify"),
    }),
    response: z.object({ valid: z.boolean(), message: z.string() }),
    async handler(ctx, args): Promise<{ valid: boolean; message: string }> {
      const okCode = await peekEmailCode(ctx, args.email, args.purpose, args.code);
      if (!okCode) return { valid: false, message: "That code isn't right, or it has expired — check the newest email, or tap Resend for a fresh code." };
      return { valid: true, message: "Code accepted." };
    },
  }),

  verifySignupCode: defineAction({
    description: "The sign-in gate's VERIFY YOUR EMAIL step in the TRN sign-up flow (email → CREATE NEW ACCOUNT? → Create New → code emailed by requestEmailCode → this check → username → password → createAccount): checks the 6-digit registration code for an email that has no account yet and, when it is right, CONSUMES it and returns a short-lived signup proof token (15 minutes, stored only as a hash) that createAccount requires — so the code step can never be skipped, yet the 1-minute code never expires while the player chooses a username and password. Wrong or expired codes fail with a clear message; 5 wrong tries kill the code.",
    request: z.object({
      email: z.string().trim().min(3).max(120),
      code: z.string().trim().min(4).max(8),
    }),
    response: z.object({ valid: z.boolean(), signupToken: z.string(), message: z.string() }),
    async handler(ctx, args): Promise<{ valid: boolean; signupToken: string; message: string }> {
      assertGmailEmail(args.email);
      await assertEmailAvailable(ctx, args.email, "");
      const okCode = await consumeEmailCode(ctx, args.email, "verify", args.code);
      if (!okCode) {
        return { valid: false, signupToken: "", message: "That code isn't right, or it has expired — check the newest email, or tap Resend for a fresh code." };
      }
      const signupToken = await issueSignupProof(ctx, args.email);
      return { valid: true, signupToken, message: "Email verified — now choose your username and password." };
    },
  }),

  resetPassword: defineAction({
    description: "Finishes Forgot password: with the emailed 6-digit reset code and a new password typed twice, sets the account's new password (stored only as a salted hash). The code is consumed on success; wrong or expired codes change nothing.",
    request: z.object({
      email: z.string().trim().min(3).max(120),
      code: z.string().trim().min(4).max(8),
      newPassword: z.string().min(1).max(72),
      confirmPassword: z.string().min(1).max(72),
    }),
    response: z.object({ reset: z.boolean(), message: z.string() }),
    async handler(ctx, args): Promise<{ reset: boolean; message: string }> {
      assertPasswordPair(args.newPassword, args.confirmPassword);
      const db = ctx.db<typeof schema>();
      const norm = args.email.trim().toLowerCase();
      const all = await db.select().from(schema.profiles);
      const me = all.find((p) => p.email.trim().toLowerCase() === norm && p.email.trim() !== "");
      if (!me) return { reset: false, message: "That code isn't right, or it has expired — request a fresh code and try again." };
      const okCode = await consumeEmailCode(ctx, args.email, "reset", args.code);
      if (!okCode) {
        return { reset: false, message: "That code isn't right, or it has expired — request a fresh code and try again." };
      }
      await db
        .update(schema.profiles)
        .set({ passwordHash: await hashPassword(args.newPassword) })
        .where(eq(schema.profiles.id, me.id));
      ctx.invalidateQueries();
      return { reset: true, message: "Your password has been reset — log in with your Gmail (or phone) and your new password." };
    },
  }),

  createAccount: defineAction({
    description: "Creates a ViceSunshine account the TRN way, exactly in this order (owner's direction, re-confirmed Nov 20 2026): email → CREATE NEW ACCOUNT? → Create New → VERIFY YOUR EMAIL with the emailed 6-digit code (requestEmailCode issues it, verifySignupCode consumes it and returns a signup proof) → username → password → account created → straight to Profile. Email verification is REQUIRED and comes BEFORE username and password — this refuses to create an account without it: pass either the signupToken from verifySignupCode (the gate's path; consumed here, 15-minute life) or the emailed code itself as emailCode (consumed here, 1-minute life). The account starts with its email verified. Also required: a unique username (checked — no two accounts share one), a valid Google email / Gmail (other providers are rejected, and one account per Gmail: an email another account uses is refused), a platform, and a password typed twice that must match (stored only as a salted hash). Everything else is done later in the Profile / Settings (display name, linked PSN / Xbox / Rockstar / Discord accounts, platform, 2-step verification — saveSettings) — sign-up asks for none of it and no phone number. New accounts start with 500 Vice Credits. If this device already has an unfinished account (created before passwords existed), this completes it instead of making a second one (email verification still required first).",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().min(2).max(32),
      email: z.string().trim().min(3).max(120),
      phone: z.string().trim().max(24).default(""),
      emailCode: z.string().trim().max(8).default(""),
      signupToken: z.string().trim().max(80).default(""),
      password: z.string().min(1).max(72),
      confirmPassword: z.string().min(1).max(72),
      platform: platformEnum.default("PS5"),
      referralCode: z.string().trim().max(12).default(""),
    }),
    response: accountCreatedResponse,
    async handler(ctx, args): Promise<z.infer<typeof accountCreatedResponse>> {
      const db = ctx.db<typeof schema>();
      assertClean(args.gamertag);
      assertNameClean(args.gamertag);
      assertGmailEmail(args.email);
      assertPasswordPair(args.password, args.confirmPassword);
      await assertUsernameAvailable(ctx, args.gamertag, args.playerKey);
      await assertEmailAvailable(ctx, args.email, args.playerKey);
      const phoneDigits = args.phone.trim() ? assertPhoneShape(args.phone) : "";
      await assertPhoneAvailable(ctx, phoneDigits, args.playerKey);
      // Email verification is REQUIRED and already happened on
      // the gate's VERIFY YOUR EMAIL step, before username and
      // password (TRN order — the code step is never skipped).
      // The gate passes the signup proof from verifySignupCode
      // (consumed here); a freshly emailed code passed directly
      // as emailCode is also accepted (consumed here). With
      // neither, no account is created.
      let emailVerified = 0;
      if (args.signupToken.trim()) {
        const okProof = await consumeEmailCode(ctx, args.email, "signup", args.signupToken);
        if (!okProof) {
          throw new Error("Your email verification has expired — go back to the Verify your email step, tap Resend for a fresh code, and enter it to continue.");
        }
        emailVerified = 1;
      } else if (args.emailCode.trim()) {
        const okCode = await consumeEmailCode(ctx, args.email, "verify", args.emailCode);
        if (!okCode) {
          throw new Error("That email confirmation code isn't right, or it has expired — go back to the Verify your email screen and tap Resend for a fresh code.");
        }
        emailVerified = 1;
      } else {
        throw new Error("Verify your email first — on the Verify your email step, enter the 6-digit code we emailed you, then choose your username and password.");
      }
      const passwordHash = await hashPassword(args.password);
      const email = args.email.trim();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const me = rows[0];
      if (me) {
        if (me.passwordHash) {
          throw new Error("This device already has a finished ViceSunshine account and you're signed in — use Log in if you meant a different account.");
        }
        // An account made before passwords existed: finish it in
        // place so everything already saved to it is kept.
        await db
          .update(schema.profiles)
          .set({ gamertag: args.gamertag, platform: args.platform, email, passwordHash, phone: phoneDigits || me.phone, emailVerified: 1 })
          .where(eq(schema.profiles.id, me.id));
        ctx.invalidateQueries();
        return { ok: true as const, gamertag: args.gamertag };
      }
      await db.insert(schema.profiles).values({
        playerKey: args.playerKey,
        gamertag: args.gamertag,
        platform: args.platform,
        region: "",
        playstyle: "Chill",
        psnId: "",
        xboxId: "",
        rockstarId: "",
        discordId: "",
        otherLinks: "[]",
        showPsn: 1,
        showXbox: 1,
        showRockstar: 0,
        showDiscord: 1,
        showOther: 1,
        email,
        phone: phoneDigits,
        emailVerified,
        passwordHash,
        credits: STARTING_CREDITS,
      });
      await logCredit(
        ctx,
        "personal",
        args.playerKey,
        args.playerKey,
        STARTING_CREDITS,
        "Welcome — your starting Vice Credits",
      );
      if (args.referralCode) {
        const mine = await db
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.playerKey, args.playerKey));
        if (mine[0]) {
          await applyReferralInternal(ctx, mine[0], args.referralCode).catch(() => undefined);
        }
      }
      ctx.invalidateQueries();
      // No confirmation email is sent at creation: the address
      // was already verified with the emailed code on the
      // VERIFY YOUR EMAIL step, before username and password.
      return { ok: true as const, gamertag: args.gamertag };
    },
  }),

  signInWithPassword: defineAction({
    description: "Signs a player back into their EXISTING account with their Gmail, phone number OR username (gamertag). Two ways in, switchable on the log-in screens (owner's direction): (1) password first — a correct password automatically emails a 6-digit Gmail log-in code, and entering that code finishes the log-in (skipEmailCode finishes with the password alone, the code screen's 'Other way'); (2) Gmail code instead of a password — a valid emailed log-in code on its own signs them in. An authenticator / backup code is still required afterwards when 2-step verification is on. On success it returns the account's player key so the device adopts the account — profile, posts, follows, crews, saves and settings all come back, because they are saved to the account, not the device. Wrong details return one generic message that never reveals which part was wrong.",
    request: z.object({
      identifier: z.string().trim().min(3).max(120),
      password: z.string().max(72).default(""),
      emailCode: z.string().trim().max(8).default(""),
      skipEmailCode: z.boolean().default(false),
      twoFactorCode: z.string().trim().max(12).default(""),
    }),
    response: signInResponse,
    async handler(ctx, args): Promise<z.infer<typeof signInResponse>> {
      const fail = (message: string, needsTwoFactor = false, needsEmailCode = false): z.infer<typeof signInResponse> => ({
        ok: false, needsTwoFactor, needsEmailCode, playerKey: "", gamertag: "", message,
      });
      const db = ctx.db<typeof schema>();
      const ident = args.identifier.trim();
      const emailNorm = ident.toLowerCase();
      const phoneNorm = phoneDigitsOf(ident);
      const all = await db.select().from(schema.profiles);
      const me = all.find((p) =>
        (p.email.trim() !== "" && p.email.trim().toLowerCase() === emailNorm) ||
        (phoneNorm.length >= 7 && p.phone !== "" && phoneDigitsOf(p.phone) === phoneNorm) ||
        p.gamertag.trim().toLowerCase() === emailNorm,
      );
      if (!me) {
        return fail("Those sign-in details don't match an account — check them and try again.");
      }
      // First factor: a valid Gmail log-in code OR the password.
      // The code is only PEEKED here — it is consumed at the very
      // end, once every required factor has passed, so a pending
      // 2-step step never burns the code.
      const emailCode = args.emailCode.trim();
      let codeOk = false;
      if (emailCode) {
        if (me.email.trim() === "" || !(await peekEmailCode(ctx, me.email, "login", emailCode))) {
          return fail("That Gmail code isn't right, or it has expired — check the newest email, or tap Resend code for a fresh one.", false, true);
        }
        codeOk = true;
      }
      let passwordOk = false;
      if (!codeOk) {
        if (!me.passwordHash) {
          // The account is real but was made before passwords
          // existed, so it has none to check against. The Gmail
          // code way in (above) still works for it; the password
          // way needs a password first — Forgot password emails
          // a code to this account's Gmail and the reset sets
          // their first password.
          return fail("This account doesn't have a password yet — it was made before ViceSunshine had passwords. Log in with a Gmail code instead (tap “Use a Gmail code instead” below), or tap “Forgot password?” and the emailed code will let you set your first password.");
        }
        if (!args.password || !(await verifyPassword(args.password, me.passwordHash))) {
          return fail("Those sign-in details don't match an account — check them and try again.");
        }
        passwordOk = true;
      }
      // Password way in, code not yet entered: email the code
      // and ask for it — unless the player chose the code
      // screen's "Other way" (skipEmailCode) to finish with the
      // password alone.
      if (passwordOk && !codeOk && !args.skipEmailCode) {
        if (me.email.trim() === "") {
          return fail("This account has no Gmail on file to send a log-in code to — finish with your password instead (the code screen's “Other way”), or add a Gmail in Settings after logging in.");
        }
        if (!(await emailCodeSentRecently(ctx, me.email, "login"))) {
          try {
            const code = await issueEmailCode(ctx, me.email, "login");
            await deliverEmailCode(ctx, me.email, "login", code);
          } catch {
            // Delivery is best-effort: the code step still
            // opens, and Resend tries again.
          }
        }
        return fail("Your password is right — we emailed a 6-digit code to your Gmail. Enter it here to finish logging in.", false, true);
      }
      if (me.twoFactorEnabled === 1) {
        const code = args.twoFactorCode.trim();
        if (!code) {
          return fail("This account has 2-step verification on — enter the 6-digit code from your authenticator app, or one of your backup codes.", true);
        }
        if (!(await verifyTotpCode(me.twoFactorSecret, code))) {
          // Backup codes are single-use: a match is consumed.
          let hashes: string[] = [];
          try { hashes = JSON.parse(me.twoFactorBackupHashes || "[]") as string[]; } catch { hashes = []; }
          const codeHash = await sha256Hex(code.toUpperCase().replace(/[^A-Z0-9]/g, ""));
          const idx = hashes.indexOf(codeHash);
          if (idx < 0) {
            return fail("That 2-step code isn't right — enter the current code from your authenticator app, or an unused backup code.", true);
          }
          hashes.splice(idx, 1);
          await db
            .update(schema.profiles)
            .set({ twoFactorBackupHashes: JSON.stringify(hashes) })
            .where(eq(schema.profiles.id, me.id));
        }
      }
      // Every required factor passed — now the Gmail code (if
      // one was used) is consumed so it can never be replayed.
      if (codeOk) await consumeEmailCode(ctx, me.email, "login", emailCode);
      return { ok: true, needsTwoFactor: false, needsEmailCode: false, playerKey: me.playerKey, gamertag: me.gamertag, message: "" };
    },
  }),

  requestLoginCode: defineAction({
    description: "Emails a fresh 6-digit Gmail log-in code to the account matching the given Gmail, phone number or username — the log-in screen's 'Use a Gmail code instead' option and the code screen's Resend. The code is delivered automatically from the official ViceSunshine Gmail. The response is the same whether or not an account matches, so it never reveals which Gmails have accounts; a fresh code is sent at most once every 20 seconds per account.",
    request: z.object({
      identifier: z.string().trim().min(3).max(120),
    }),
    response: z.object({
      ok: z.boolean(),
      message: z.string(),
    }),
    async handler(ctx, args): Promise<{ ok: boolean; message: string }> {
      const db = ctx.db<typeof schema>();
      const ident = args.identifier.trim();
      const emailNorm = ident.toLowerCase();
      const phoneNorm = phoneDigitsOf(ident);
      const all = await db.select().from(schema.profiles);
      const me = all.find((p) =>
        (p.email.trim() !== "" && p.email.trim().toLowerCase() === emailNorm) ||
        (phoneNorm.length >= 7 && p.phone !== "" && phoneDigitsOf(p.phone) === phoneNorm) ||
        p.gamertag.trim().toLowerCase() === emailNorm,
      );
      if (me && me.email.trim() !== "" && !(await emailCodeSentRecently(ctx, me.email, "login"))) {
        try {
          const code = await issueEmailCode(ctx, me.email, "login");
          await deliverEmailCode(ctx, me.email, "login", code);
        } catch {
          // Best-effort — the generic message below still shows.
        }
      }
      return {
        ok: true,
        message: "If that Gmail matches an account, a 6-digit log-in code is on its way — it lasts 1 minute. A fresh code can be sent after 20 seconds.",
      };
    },
  }),

  verifyAccountPassword: defineAction({
    description: "Checks a password the signed-in player types to unlock their account info in Settings (owner's direction: account info sits behind the account password). Returns only whether it matched — no account data. Accounts without a password cannot unlock this way and are told to set one first.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      password: z.string().min(1).max(200),
    }),
    response: z.object({ ok: z.boolean(), hasPassword: z.boolean() }),
    async handler(ctx, args): Promise<{ ok: boolean; hasPassword: boolean }> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const p = rows[0];
      if (!p || !p.passwordHash) return { ok: false, hasPassword: false };
      return { ok: await verifyPassword(args.password, p.passwordHash), hasPassword: true };
    },
  }),

  setPassword: defineAction({
    description: "Sets or changes the account password from Settings (or when finishing sign-up on an older account). The new password is typed twice and must match; changing an existing password also requires the current one. Only a salted hash is stored — the password itself is never saved or shown anywhere.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      currentPassword: z.string().max(72).default(""),
      newPassword: z.string().min(1).max(72),
      confirmPassword: z.string().min(1).max(72),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const me = rows[0];
      if (!me) throw new Error("Create your account first — then you can set a password.");
      assertPasswordPair(args.newPassword, args.confirmPassword);
      if (me.passwordHash) {
        if (!(await verifyPassword(args.currentPassword, me.passwordHash))) {
          throw new Error("Your current password isn't right — type it again to change your password.");
        }
      }
      await db
        .update(schema.profiles)
        .set({ passwordHash: await hashPassword(args.newPassword) })
        .where(eq(schema.profiles.id, me.id));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  startTwoFactorSetup: defineAction({
    description: "Starts 2-step verification setup: generates a fresh authenticator secret for the account and returns it with its otpauth URI (for a QR code / manual entry in Google Authenticator, Authy or any TOTP app). Nothing is switched on until confirmTwoFactorSetup proves the player entered a valid code.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: twoFactorSetupResponse,
    async handler(ctx, args): Promise<z.infer<typeof twoFactorSetupResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const me = rows[0];
      if (!me) throw new Error("Create your account first — then you can set up 2-step verification.");
      const secret = base32Encode(crypto.getRandomValues(new Uint8Array(10)));
      await db
        .update(schema.profiles)
        .set({ twoFactorSecret: secret })
        .where(eq(schema.profiles.id, me.id));
      const otpauthUri = `otpauth://totp/ViceSunshine:${encodeURIComponent(me.gamertag)}?secret=${secret}&issuer=ViceSunshine&digits=6&period=30`;
      return { secret, otpauthUri };
    },
  }),

  confirmTwoFactorSetup: defineAction({
    description: "Finishes 2-step verification setup: checks the 6-digit authenticator code against the pending secret, switches 2-step verification ON for the account, and returns 10 one-time backup codes (shown to the player exactly once — only their hashes are stored, and each code works a single time at sign-in).",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      code: z.string().trim().min(6).max(8),
    }),
    response: twoFactorConfirmResponse,
    async handler(ctx, args): Promise<z.infer<typeof twoFactorConfirmResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const me = rows[0];
      if (!me) throw new Error("Create your account first — then you can set up 2-step verification.");
      if (!me.twoFactorSecret) {
        throw new Error("Start the setup first — tap “Set up 2-step verification” to get your secret key.");
      }
      if (!(await verifyTotpCode(me.twoFactorSecret, args.code))) {
        throw new Error("That code doesn't match — enter the current 6-digit code your authenticator app shows for ViceSunshine.");
      }
      const backupCodes = newBackupCodes();
      const hashes = await Promise.all(
        backupCodes.map((c) => sha256Hex(c.toUpperCase().replace(/[^A-Z0-9]/g, ""))),
      );
      await db
        .update(schema.profiles)
        .set({ twoFactorEnabled: 1, twoFactorBackupHashes: JSON.stringify(hashes) })
        .where(eq(schema.profiles.id, me.id));
      ctx.invalidateQueries();
      return { ok: true as const, backupCodes };
    },
  }),

  disableTwoFactor: defineAction({
    description: "Turns 2-step verification OFF for the account (Settings). Requires the account password when one is set, then clears the authenticator secret and every backup code.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      password: z.string().max(72).default(""),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const me = rows[0];
      if (!me) throw new Error("Create your account first.");
      if (me.passwordHash && !(await verifyPassword(args.password, me.passwordHash))) {
        throw new Error("Your password isn't right — type it to turn off 2-step verification.");
      }
      await db
        .update(schema.profiles)
        .set({ twoFactorEnabled: 0, twoFactorSecret: "", twoFactorBackupHashes: "" })
        .where(eq(schema.profiles.id, me.id));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  getAccountSaves: defineAction({
    description: "Returns everything saved ON the account (server-side): the Saved library (news / guides / bugs / crews / Easter eggs / events), tracked Goals items (kind “tracked”, snapshot in meta), saved Database entries (kind “db”) and the player's map setup (kind “mapprefs”, refId 0, setup JSON in meta). Because these live on the account, they come back on any device the player signs in on — they are never lost with a device.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({
      items: z.array(z.object({ kind: z.string(), refId: z.number(), meta: z.string() })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.accountSaves)
        .where(eq(schema.accountSaves.playerKey, args.playerKey));
      return { items: rows.map((r) => ({ kind: r.kind, refId: r.refId, meta: r.meta })) };
    },
  }),

  setAccountSave: defineAction({
    description: "Saves or un-saves one item ON the account (server-side): a Saved-library item (news / guide / bug / clan / egg / event), a tracked Goals item (kind “tracked”, full snapshot as JSON in meta), a Database entry (kind “db”), or the player's map setup (kind “mapprefs”, refId 0, the whole setup — done pins, visible categories, Day/Night and layer filters — as JSON in meta). Account saves persist forever with the account and sync back to every signed-in device.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      kind: z.enum(["news", "guide", "bug", "clan", "egg", "event", "tracked", "db", "mapprefs"]),
      refId: z.number().int(),
      saved: z.boolean(),
      meta: z.string().max(40000).default(""),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      const rows = await db
        .select()
        .from(schema.accountSaves)
        .where(
          and(
            eq(schema.accountSaves.playerKey, args.playerKey),
            eq(schema.accountSaves.kind, args.kind),
            eq(schema.accountSaves.refId, args.refId),
          ),
        );
      const existing = rows[0];
      if (args.saved) {
        if (existing) {
          if (existing.meta !== args.meta) {
            await db
              .update(schema.accountSaves)
              .set({ meta: args.meta })
              .where(eq(schema.accountSaves.id, existing.id));
          }
        } else {
          await db.insert(schema.accountSaves).values({
            playerKey: args.playerKey,
            kind: args.kind,
            refId: args.refId,
            meta: args.meta,
          });
        }
      } else if (existing) {
        await db.delete(schema.accountSaves).where(eq(schema.accountSaves.id, existing.id));
      }
      ctx.invalidateQueries();
      return ok();
    },
  }),

  saveProfile: defineAction({
    description: "Creates or updates the player's profile, including linked accounts and their visibility.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().min(2).max(32),
      platform: platformEnum.default("PS5"),
      region: z.string().trim().max(40).default(""),
      playstyle: z.string().trim().max(40).default(""),
      psnId: z.string().trim().max(60).default(""),
      xboxId: z.string().trim().max(60).default(""),
      // Optional Rockstar Social Club ID — never required, and its
      // visibility defaults to PRIVATE (crew-only), the safe default.
      rockstarId: z.string().trim().max(60).default(""),
      discordId: z.string().trim().max(60).default(""),
      others: z
        .array(z.object({ label: z.string().trim().min(1).max(30), url: z.string().trim().min(3).max(300) }))
        .max(5)
        .default([]),
      showPsn: z.boolean().default(true),
      showXbox: z.boolean().default(true),
      showRockstar: z.boolean().default(false),
      showDiscord: z.boolean().default(true),
      showOther: z.boolean().default(true),
      // A friend's referral code, applied only when this call CREATES
      // the profile (arriving via a referral link) — see applyReferral.
      referralCode: z.string().trim().max(12).default(""),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      assertClean(args.gamertag);
      assertNameClean(args.gamertag);
      await assertUsernameAvailable(ctx, args.gamertag, args.playerKey);
      const values = {
        gamertag: args.gamertag,
        platform: args.platform,
        region: args.region,
        playstyle: args.playstyle,
        psnId: args.psnId,
        xboxId: args.xboxId,
        rockstarId: args.rockstarId,
        discordId: args.discordId,
        otherLinks: JSON.stringify(args.others),
        showPsn: args.showPsn ? 1 : 0,
        showXbox: args.showXbox ? 1 : 0,
        showRockstar: args.showRockstar ? 1 : 0,
        showDiscord: args.showDiscord ? 1 : 0,
        showOther: args.showOther ? 1 : 0,
      };
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      if (rows[0]) {
        // The username is permanent once the account exists.
        assertGamertagPermanent(rows[0].gamertag, args.gamertag);
        await db.update(schema.profiles).set({ ...values, ...usernameChangeFields(rows[0], args.gamertag) }).where(eq(schema.profiles.id, rows[0].id));
      } else {
        // New account: starts with 500 Vice Credits — exactly enough to
        // create one clan.
        await db
          .insert(schema.profiles)
          .values({ playerKey: args.playerKey, ...values, credits: STARTING_CREDITS });
        await logCredit(
          ctx,
          "personal",
          args.playerKey,
          args.playerKey,
          STARTING_CREDITS,
          "Welcome — your starting Vice Credits",
        );
        if (args.referralCode) {
          const mine = await db
            .select()
            .from(schema.profiles)
            .where(eq(schema.profiles.playerKey, args.playerKey));
          if (mine[0]) {
            // Best-effort at signup: an invalid code never blocks
            // account creation; Settings can apply a code later too.
            await applyReferralInternal(ctx, mine[0], args.referralCode).catch(() => undefined);
          }
        }
      }
      ctx.invalidateQueries();
      return ok();
    },
  }),

  updateProfile: defineAction({
    description: "Saves the X-style Edit profile sheet in one call: display name, username (gamertag), bio, location, website, birth date (private — owner only, never displayed publicly), platform, and the profile settings (private profile, show crew). This is THE save behind Edit profile on the Profile page — what the player types there is exactly what lands on their profile and what other players then see. Creates the profile (with the 500 starting Vice Credits) when the player does not have one yet, so the same sheet works for Create Profile. Avatar and banner / calling card are picked in the same sheet but saved by their own equip / upload actions.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      displayName: z.string().trim().max(50).default(""),
      gamertag: z.string().trim().min(2).max(32),
      bio: z.string().trim().max(300).default(""),
      clanTag: z.string().trim().max(10).default(""),
      location: z.string().trim().max(60).default(""),
      website: z.string().trim().max(120).default(""),
      dob: z.string().trim().max(10).default(""),
      platform: platformEnum.default("PS5"),
      profilePrivate: z.boolean().default(false),
      showClan: z.boolean().default(true),
    }),
    response: z.object({
      ok: z.literal(true),
      displayName: z.string(),
      gamertag: z.string(),
      bio: z.string(),
      clanTag: z.string(),
      location: z.string(),
      website: z.string(),
    }),
    async handler(ctx, args): Promise<{ ok: true; displayName: string; gamertag: string; bio: string; clanTag: string; location: string; website: string }> {
      const db = ctx.db<typeof schema>();
      assertClean(args.gamertag, args.displayName);
      assertNameClean(args.gamertag, args.displayName);
      await assertUsernameAvailable(ctx, args.gamertag, args.playerKey);
      const bioReason = screenText(args.bio, true);
      if (bioReason) {
        throw new Error(`Blocked by automatic moderation: ${bioReason}.`);
      }
      const locationReason = args.location ? screenText(args.location, true) : null;
      if (locationReason) {
        throw new Error(`Blocked by automatic moderation: ${locationReason}.`);
      }
      if (args.website && /\s/.test(args.website)) {
        throw new Error("Your website can't contain spaces — paste just the address, like yoursite.com.");
      }
      const websiteReason = args.website ? screenText(args.website, true) : null;
      if (websiteReason) {
        throw new Error(`Blocked by automatic moderation: ${websiteReason}.`);
      }
      if (args.dob && !/^\d{4}-\d{2}-\d{2}$/.test(args.dob)) {
        throw new Error("That birth date doesn't look right — use the date picker.");
      }
      const clanTagReason = args.clanTag ? screenText(args.clanTag, true) : null;
      if (clanTagReason) {
        throw new Error(`Blocked by automatic moderation: ${clanTagReason}.`);
      }
      const values = {
        displayName: args.displayName,
        gamertag: args.gamertag,
        bio: args.bio,
        clanTag: args.clanTag.toUpperCase(),
        location: args.location,
        website: args.website,
        dob: args.dob,
        platform: args.platform,
        profilePrivate: args.profilePrivate ? 1 : 0,
        showClan: args.showClan ? 1 : 0,
      };
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      if (rows[0]) {
        // The username / gamertag is permanent (owner's
        // direction): chosen at account creation, it can never
        // be changed afterwards — unlike the display name.
        assertGamertagPermanent(rows[0].gamertag, args.gamertag);
        // Display name and clan tag each change once every 30
        // days (Premium: any time).
        const premium = await premiumActiveFor(ctx, args.playerKey);
        const nameGate = nameChangeGate("display name", rows[0].displayName, args.displayName, rows[0].displayNameChangedAt, premium);
        if (nameGate.blocked) throw new Error(nameGate.blocked);
        const tagGate = nameChangeGate("clan tag", rows[0].clanTag, args.clanTag, rows[0].clanTagChangedAt, premium);
        if (tagGate.blocked) throw new Error(tagGate.blocked);
        await db.update(schema.profiles).set({
          ...values,
          ...(nameGate.stamp ? { displayNameChangedAt: new Date() } : {}),
          ...(tagGate.stamp ? { clanTagChangedAt: new Date() } : {}),
        }).where(eq(schema.profiles.id, rows[0].id));
      } else {
        await db
          .insert(schema.profiles)
          .values({ playerKey: args.playerKey, ...values, credits: STARTING_CREDITS });
        await logCredit(
          ctx,
          "personal",
          args.playerKey,
          args.playerKey,
          STARTING_CREDITS,
          "Welcome — your starting Vice Credits",
        );
      }
      ctx.invalidateQueries();
      return {
        ok: true as const,
        displayName: args.displayName,
        gamertag: args.gamertag,
        bio: args.bio,
        clanTag: args.clanTag.toUpperCase(),
        location: args.location,
        website: args.website,
      };
    },
  }),

  getSettings: defineAction({
    description: "Returns everything the Settings page manages: profile fields, linked accounts and their visibility, privacy and notification preferences, locale preferences, Premium state, Refer a Friend stats, and the blocked-users list.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({
      hasProfile: z.boolean(),
      gamertag: z.string(),
      displayName: z.string(),
      bio: z.string(),
      location: z.string(),
      website: z.string(),
      email: z.string(),
      platform: z.string(),
      region: z.string(),
      playstyle: z.string(),
      psnId: z.string(),
      xboxId: z.string(),
      rockstarId: z.string(),
      discordId: z.string(),
      showPsn: z.boolean(),
      showXbox: z.boolean(),
      showRockstar: z.boolean(),
      showDiscord: z.boolean(),
      showOther: z.boolean(),
      profilePrivate: z.boolean(),
      showClan: z.boolean(),
      notifyReposts: z.boolean(),
      notifyParty: z.boolean(),
      language: z.string(),
      currency: z.string(),
      timezone: z.string(),
      themeAccent: z.string(),
      premium: z.boolean(),
      hasPassword: z.boolean(),
      twoFactorEnabled: z.boolean(),
      presence: z.string(),
      customStatus: z.string(),
      hasCustomAvatar: z.boolean(),
      avatarUrl: z.string(),
      phone: z.string(),
      emailVerified: z.boolean(),
      referral: z.object({
        code: z.string(),
        referrals: z.number(),
        creditsEarned: z.number(),
        referredByCode: z.string(),
      }),
      blocked: z.array(z.object({ playerKey: z.string(), gamertag: z.string() })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const p = rows[0];
      const empty = {
        hasProfile: false, gamertag: "", displayName: "", bio: "", location: "", website: "", email: "",
        platform: "PS5", region: "", playstyle: "", psnId: "", xboxId: "", rockstarId: "", discordId: "",
        showPsn: true, showXbox: true, showRockstar: false, showDiscord: true, showOther: true,
        profilePrivate: false, showClan: true, notifyReposts: true, notifyParty: true,
        language: "en", currency: "", timezone: "", themeAccent: "", premium: false, hasPassword: false, twoFactorEnabled: false, presence: "Online", customStatus: "", hasCustomAvatar: false, avatarUrl: "", phone: "", emailVerified: false,
        referral: { code: referralCodeFor(args.playerKey), referrals: 0, creditsEarned: 0, referredByCode: "" },
        blocked: [] as { playerKey: string; gamertag: string }[],
      };
      if (!p) return empty;
      await touchPresence(ctx, args.playerKey);
      const code = p.referralCode || referralCodeFor(p.playerKey);
      if (!p.referralCode) {
        await db.update(schema.profiles).set({ referralCode: code }).where(eq(schema.profiles.id, p.id));
      }
      const all = await db.select().from(schema.profiles);
      const referrals = all.filter((x) => x.referredBy === code).length;
      // Vice Credits this player has earned from referrals so far —
      // the sum of their "Referral bonus" wallet transactions.
      const myTxs = await db
        .select()
        .from(schema.creditTransactions)
        .where(eq(schema.creditTransactions.ownerId, args.playerKey));
      const referralCreditsEarned = myTxs
        .filter((t) => t.scope === "personal" && t.reason.startsWith("Referral bonus"))
        .reduce((s, t) => s + t.amount, 0);
      const blockedRows = await db
        .select()
        .from(schema.blockedUsers)
        .where(eq(schema.blockedUsers.playerKey, args.playerKey));
      return {
        hasProfile: true,
        gamertag: p.gamertag,
        displayName: p.displayName,
        bio: p.bio,
        location: p.location,
        website: p.website,
        email: p.email,
        platform: p.platform,
        region: p.region,
        playstyle: p.playstyle,
        psnId: p.psnId,
        xboxId: p.xboxId,
        rockstarId: p.rockstarId,
        discordId: p.discordId,
        showPsn: p.showPsn === 1,
        showXbox: p.showXbox === 1,
        showRockstar: p.showRockstar === 1,
        showDiscord: p.showDiscord === 1,
        showOther: p.showOther === 1,
        profilePrivate: p.profilePrivate === 1,
        showClan: p.showClan === 1,
        notifyReposts: p.notifyReposts === 1,
        notifyParty: p.notifyParty === 1,
        language: p.language,
        currency: p.currency,
        timezone: p.timezone,
        themeAccent: p.themeAccent,
        premium: p.premium === 1,
        hasPassword: Boolean(p.passwordHash),
        twoFactorEnabled: p.twoFactorEnabled === 1,
        presence: p.presence || "Online",
        customStatus: p.customStatus ?? "",
        hasCustomAvatar: Boolean(p.customAvatarBlobKey),
        avatarUrl: await profileAvatarUrl(ctx, await avatarArtUrls(ctx), p),
        phone: p.phone,
        emailVerified: p.emailVerified === 1,
        referral: {
          code,
          referrals,
          creditsEarned: referralCreditsEarned,
          referredByCode: p.referredBy,
        },
        blocked: blockedRows.map((b) => ({ playerKey: b.blockedKey, gamertag: b.blockedGamertag })),
      };
    },
  }),

  setPresence: defineAction({
    description: "Sets how the player appears to others: Online, Away, Do Not Disturb, Ghost (appear offline while actually online — everyone else sees Offline) or Offline. Applies instantly everywhere presence is shown (profile, crew roster, friends, player directory) and refreshes the player's activity heartbeat.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      presence: z.enum(["Online", "Away", "Do Not Disturb", "Ghost", "Offline"]),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const p = rows[0];
      if (!p) throw new Error("Create your profile first — then you can set how you appear.");
      await db
        .update(schema.profiles)
        .set({ presence: args.presence, lastSeen: new Date() })
        .where(eq(schema.profiles.id, p.id));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  setOnlineStatus: defineAction({
    description: "Sets the player's Discord-style online status from the Change Online Status sheet: presence (Online, Away — shown as Idle, Do Not Disturb, Ghost — shown as Invisible, or Offline) and/or a custom status text. The custom status is screened by automatic moderation before it is stored and shows in the Add Status bubble on the player's profile. Invisible (Ghost) means everyone else sees Offline while the player is actually online.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      presence: z.enum(["Online", "Away", "Do Not Disturb", "Ghost", "Offline"]).optional(),
      customStatus: z.string().trim().max(80).optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const prof = rows[0];
      if (!prof) throw new Error("Create your profile first — then you can set your status.");
      if (args.presence === undefined && args.customStatus === undefined) {
        throw new Error("Nothing to update — pick a status or write a custom status.");
      }
      if (args.customStatus) assertClean(args.customStatus);
      const patch: { presence?: "Online" | "Away" | "Do Not Disturb" | "Ghost" | "Offline"; customStatus?: string; lastSeen: Date } = { lastSeen: new Date() };
      if (args.presence !== undefined) patch.presence = args.presence;
      if (args.customStatus !== undefined) patch.customStatus = args.customStatus;
      await db.update(schema.profiles).set(patch).where(eq(schema.profiles.id, prof.id));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  uploadCustomAvatar: defineAction({
    description: "Uploads the player's OWN avatar / profile picture. JPG or PNG only, up to 4 MB — every picture is checked by automatic moderation BEFORE it is stored: nude, sexual or illegal pictures are blocked and never stored. On success the custom picture replaces the catalogue avatar everywhere the player's avatar appears (profile, Feed, crew roster, directory) until it is removed or a catalogue avatar is equipped.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      filename: z.string().trim().min(1).max(120),
      mimeType: z.string().min(3).max(60),
      dataBase64: z.string().min(10).max(6000000),
    }),
    response: z.object({ url: z.string() }),
    async handler(ctx, args) {
      if (args.mimeType !== "image/jpeg" && args.mimeType !== "image/png") {
        throw new Error("Avatar pictures must be JPG or PNG — those are the formats the automatic safety check can read, so no avatar picture can skip the check.");
      }
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const prof = rows[0];
      if (!prof) throw new Error("Create your profile first — then you can upload your own avatar picture.");
      const bytes = Buffer.from(args.dataBase64, "base64");
      if (bytes.length > 4 * 1024 * 1024) {
        throw new Error("That picture is over the 4 MB limit — please compress it and try again.");
      }
      await assertImageAllowed(ctx, args.dataBase64, args.mimeType, args.filename, "picture");
      const safeName = args.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
      const key = `avatars/${args.playerKey}/${Date.now()}-${safeName}`;
      await ctx.blobs.put(key, bytes, { contentType: args.mimeType });
      await db
        .update(schema.profiles)
        .set({ customAvatarBlobKey: key })
        .where(eq(schema.profiles.id, prof.id));
      const url = await ctx.blobs.getUrl(key);
      ctx.invalidateQueries();
      return { url };
    },
  }),

  removeCustomAvatar: defineAction({
    description: "Removes the player's uploaded custom avatar picture, so the equipped catalogue avatar (or initials) shows again everywhere.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const prof = rows[0];
      if (!prof) throw new Error("Create your profile first.");
      await db
        .update(schema.profiles)
        .set({ customAvatarBlobKey: "" })
        .where(eq(schema.profiles.id, prof.id));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  uploadCustomBanner: defineAction({
    description: "Uploads the player's OWN profile banner media from Edit profile: a picture (JPG or PNG, up to 4 MB, checked by automatic moderation BEFORE it is stored — nude or illegal pictures are blocked and never stored) or a short video (MP4 or WebM, up to 12 MB). While set, the uploaded media is the profile banner, taking precedence over the calling card; choosing a calling card or removing the media brings the calling card back.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      filename: z.string().trim().min(1).max(120),
      mimeType: z.string().min(3).max(60),
      dataBase64: z.string().min(10).max(17000000),
    }),
    response: z.object({ url: z.string(), mediaType: z.string() }),
    async handler(ctx, args) {
      const isImage = args.mimeType === "image/jpeg" || args.mimeType === "image/png";
      const isVideo = args.mimeType === "video/mp4" || args.mimeType === "video/webm";
      if (!isImage && !isVideo) {
        throw new Error("Banner uploads must be a JPG or PNG picture, or an MP4 or WebM video — those are the formats ViceSunshine can store and show.");
      }
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const prof = rows[0];
      if (!prof) throw new Error("Create your profile first — then you can upload your own banner.");
      const bytes = Buffer.from(args.dataBase64, "base64");
      const limit = isImage ? 4 * 1024 * 1024 : 12 * 1024 * 1024;
      if (bytes.length > limit) {
        throw new Error(
          isImage
            ? "That picture is over the 4 MB limit — please compress it and try again."
            : "That video is over the 12 MB limit — please trim it and try again.",
        );
      }
      if (isImage) await assertImageAllowed(ctx, args.dataBase64, args.mimeType, args.filename, "picture");
      const safeName = args.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
      const key = `banners/${args.playerKey}/${Date.now()}-${safeName}`;
      await ctx.blobs.put(key, bytes, { contentType: args.mimeType });
      await db
        .update(schema.profiles)
        .set({ bannerBlobKey: key, bannerMediaType: isVideo ? "video" : "image" })
        .where(eq(schema.profiles.id, prof.id));
      const url = await ctx.blobs.getUrl(key);
      ctx.invalidateQueries();
      return { url, mediaType: isVideo ? "video" : "image" };
    },
  }),

  removeCustomBanner: defineAction({
    description: "Removes the player's uploaded banner media, so their calling card is the profile banner again.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const prof = rows[0];
      if (!prof) throw new Error("Create your profile first.");
      await db
        .update(schema.profiles)
        .set({ bannerBlobKey: "", bannerMediaType: "" })
        .where(eq(schema.profiles.id, prof.id));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  saveSettings: defineAction({
    description: "Saves the Settings page: profile (username — kept unique across all accounts, display name, bio), contact email (must stay a Gmail address; changing it requires typing the new email twice to confirm), linked accounts and who can see them, privacy (public / private profile, crew visibility), notifications, locale (language, currency, timezone, region) and appearance accent. The account password and 2-step verification are managed by their own actions (setPassword / two-factor setup); day-to-day sign-in on the player's own device stays the device key.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().min(2).max(32),
      displayName: z.string().trim().max(40).default(""),
      bio: z.string().trim().max(300).default(""),
      // Location / website are edited in the profile's Edit
      // profile sheet (updateProfile); Settings only overwrites
      // them when a caller actually sends them, so saving Settings
      // can never wipe what Edit profile saved.
      location: z.string().trim().max(60).optional(),
      website: z.string().trim().max(120).optional(),
      email: z.string().trim().max(120).default(""),
      confirmEmail: z.string().trim().max(120).default(""),
      // Optional phone for phone + password log-in; only overwritten
      // when a caller actually sends it, like location / website.
      phone: z.string().trim().max(24).optional(),
      platform: platformEnum.default("PS5"),
      region: z.string().trim().max(40).default(""),
      playstyle: z.string().trim().max(40).default(""),
      psnId: z.string().trim().max(60).default(""),
      xboxId: z.string().trim().max(60).default(""),
      rockstarId: z.string().trim().max(60).default(""),
      discordId: z.string().trim().max(60).default(""),
      showPsn: z.boolean().default(true),
      showXbox: z.boolean().default(true),
      showRockstar: z.boolean().default(false),
      showDiscord: z.boolean().default(true),
      showOther: z.boolean().default(true),
      profilePrivate: z.boolean().default(false),
      showClan: z.boolean().default(true),
      notifyReposts: z.boolean().default(true),
      notifyParty: z.boolean().default(true),
      language: z.string().trim().max(8).default("en"),
      currency: z.string().trim().max(3).default(""),
      timezone: z.string().trim().max(60).default(""),
      themeAccent: z.string().trim().max(9).default(""),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      assertClean(args.gamertag, args.displayName);
      assertNameClean(args.gamertag, args.displayName);
      const bioReason = screenText(args.bio, true);
      if (bioReason) {
        throw new Error(`Blocked by automatic moderation: ${bioReason}.`);
      }
      const locationReason = args.location ? screenText(args.location, true) : null;
      if (locationReason) {
        throw new Error(`Blocked by automatic moderation: ${locationReason}.`);
      }
      if (args.website && /\s/.test(args.website)) {
        throw new Error("Your website can't contain spaces — paste just the address, like yoursite.com.");
      }
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const p = rows[0];
      if (!p) throw new Error("Create your profile first (Profile page) — Settings then manages it here.");
      // Usernames stay unique across every rename path, and an
      // account's email stays a Google email: changing it requires a
      // Gmail address, exactly like sign-up.
      await assertUsernameAvailable(ctx, args.gamertag, args.playerKey);
      if (args.email && args.email !== p.email) assertGmailEmail(args.email);
      if (args.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email)) {
        throw new Error("That email address doesn't look complete — check it and try again.");
      }
      // Changing the contact email is a confirmed change: the new
      // address must be typed twice, and the two entries must match.
      if (args.email !== p.email && args.confirmEmail !== args.email) {
        throw new Error("To change your email, type the new address in both email boxes — they don't match yet.");
      }
      // One account per Gmail, everywhere: a changed email can never
      // be one another account already uses. A changed email also
      // starts unverified again — it can be confirmed from Settings.
      const emailChanged = args.email.trim().toLowerCase() !== p.email.trim().toLowerCase();
      if (emailChanged && args.email) await assertEmailAvailable(ctx, args.email, args.playerKey);
      // Phone (when sent): digits-only, one account per number.
      let phoneSet: string | undefined;
      if (args.phone !== undefined) {
        phoneSet = args.phone.trim() ? assertPhoneShape(args.phone) : "";
        await assertPhoneAvailable(ctx, phoneSet, args.playerKey);
      }
      // The username is permanent, and the display name changes
      // at most once every 30 days (Premium: any time) — the
      // same rules as Edit profile, enforced on this path too.
      assertGamertagPermanent(p.gamertag, args.gamertag);
      const premium = await premiumActiveFor(ctx, args.playerKey);
      const nameGate = nameChangeGate("display name", p.displayName, args.displayName, p.displayNameChangedAt, premium);
      if (nameGate.blocked) throw new Error(nameGate.blocked);
      await db
        .update(schema.profiles)
        .set({
          gamertag: args.gamertag,
          ...usernameChangeFields(p, args.gamertag),
          displayName: args.displayName,
          ...(nameGate.stamp ? { displayNameChangedAt: new Date() } : {}),
          bio: args.bio,
          ...(args.location !== undefined ? { location: args.location } : {}),
          ...(args.website !== undefined ? { website: args.website } : {}),
          ...(phoneSet !== undefined ? { phone: phoneSet } : {}),
          ...(emailChanged ? { emailVerified: 0 } : {}),
          email: args.email,
          platform: args.platform,
          region: args.region,
          playstyle: args.playstyle,
          psnId: args.psnId,
          xboxId: args.xboxId,
          rockstarId: args.rockstarId,
          discordId: args.discordId,
          showPsn: args.showPsn ? 1 : 0,
          showXbox: args.showXbox ? 1 : 0,
          showRockstar: args.showRockstar ? 1 : 0,
          showDiscord: args.showDiscord ? 1 : 0,
          showOther: args.showOther ? 1 : 0,
          profilePrivate: args.profilePrivate ? 1 : 0,
          showClan: args.showClan ? 1 : 0,
          notifyReposts: args.notifyReposts ? 1 : 0,
          notifyParty: args.notifyParty ? 1 : 0,
          language: args.language,
          currency: args.currency.toUpperCase(),
          timezone: args.timezone,
          themeAccent: args.themeAccent,
        })
        .where(eq(schema.profiles.id, p.id));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  applyReferral: defineAction({
    description: "Applies a friend's referral code to this player's account: one use per player. The referrer earns 200 Vice Credits (enough for one extra community event beyond the weekly limit) plus +15 XP for the recruit — counted automatically, like every in-app reward.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      code: z.string().trim().min(3).max(12),
    }),
    response: z.object({ ok: z.boolean(), message: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const me = rows[0];
      if (!me) throw new Error("Create your profile first — then a referral code can be applied to it.");
      const res = await applyReferralInternal(ctx, me, args.code);
      if (!res.ok) throw new Error(res.message);
      ctx.invalidateQueries();
      return res;
    },
  }),

  blockUser: defineAction({
    description: "Blocks a player by gamertag: their Feed posts are hidden from the blocker.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      targetGamertag: z.string().trim().min(2).max(32),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const profs = await db.select().from(schema.profiles);
      const target = profs.find((p) => p.gamertag.toLowerCase() === args.targetGamertag.toLowerCase());
      if (!target) throw new Error("No ViceSunshine player with that gamertag.");
      if (target.playerKey === args.playerKey) throw new Error("You can't block yourself.");
      const existing = await db
        .select()
        .from(schema.blockedUsers)
        .where(eq(schema.blockedUsers.playerKey, args.playerKey));
      if (!existing.some((b) => b.blockedKey === target.playerKey)) {
        await db.insert(schema.blockedUsers).values({
          playerKey: args.playerKey,
          blockedKey: target.playerKey,
          blockedGamertag: target.gamertag,
        });
      }
      // Blocking severs the follow relationship both ways, so a
      // blocked player stops following you and you stop following
      // them — they cannot see or interact with you any more.
      await db.delete(schema.profileFollows).where(and(eq(schema.profileFollows.followerKey, args.playerKey), eq(schema.profileFollows.followingKey, target.playerKey)));
      await db.delete(schema.profileFollows).where(and(eq(schema.profileFollows.followerKey, target.playerKey), eq(schema.profileFollows.followingKey, args.playerKey)));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  unblockUser: defineAction({
    description: "Removes a player from the block list.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      blockedKey: z.string().min(1).max(80),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.blockedUsers)
        .where(eq(schema.blockedUsers.playerKey, args.playerKey));
      const row = rows.find((b) => b.blockedKey === args.blockedKey);
      if (row) await db.delete(schema.blockedUsers).where(eq(schema.blockedUsers.id, row.id));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  listPlayers: defineAction({
    description: "Lists player profiles for the directory, with search.",
    request: z.object({ search: z.string().max(80).default("") }),
    response: z.object({
      items: z.array(
        z.object({
          playerKey: z.string(),
          gamertag: z.string(),
          platform: z.string(),
          region: z.string(),
          playstyle: z.string(),
          reputation: z.number(),
          premium: z.boolean(),
          badge: z.string(),
          inVoice: z.boolean(),
          viceLevel: z.number(),
          isPrivate: z.boolean(),
          displayName: z.string(),
          bio: z.string(),
          nameColor: z.string(),
          avatarFrame: z.string(),
          avatarId: z.string(),
          avatarUrl: z.string(),
          avatarEffect: z.string(),
          presence: z.string(),
          bannerColor: z.string(),
          themeAccent: z.string(),
          links: linksShape,
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let rows = await db.select().from(schema.profiles).orderBy(desc(schema.profiles.reputation));
      const q = args.search.trim().toLowerCase();
      if (q) rows = rows.filter((r) => r.gamertag.toLowerCase().includes(q));
      const events = await db.select().from(schema.rankPointEvents);
      const artUrls = await avatarArtUrls(ctx);
      const customArt = await customAvatarUrls(ctx);
      return {
        items: rows.slice(0, 100).map((r) => {
          // Private profiles: the public directory shows only who they
          // are (name, level, premium) — region, playstyle, bio and
          // linked accounts stay hidden here. Clanmates still see the
          // full roster card inside their clan.
          const priv = r.profilePrivate === 1;
          return {
            playerKey: r.playerKey,
            gamertag: r.gamertag,
            platform: r.platform,
            region: priv ? "" : r.region,
            playstyle: priv ? "" : r.playstyle,
            reputation: r.reputation,
            premium: r.premium === 1,
            badge: r.badge,
            inVoice: false,
            viceLevel: playerLevelFromPoints(personalPointsOf(events, r.playerKey)).level,
            isPrivate: priv,
            displayName: r.displayName,
            bio: priv ? "" : r.bio,
            nameColor: "",
            avatarFrame: "",
            avatarId: r.avatarId,
            avatarUrl: pickAvatar(artUrls, customArt, r),
            avatarEffect: r.avatarEffect,
            presence: effectivePresence(r, ""),
            bannerColor: "",
            themeAccent: r.themeAccent,
            links: priv ? { psn: "", xbox: "", discord: "", rockstar: "", others: [] } : visibleLinks(r),
          };
        }),
      };
    },
  }),

  findPlayerByGamertag: defineAction({
    description: "Resolves a shared profile link handle (#player=<handle>) to the player's key, so a profile link shared outside ViceSunshine opens that exact profile. Matches the gamertag case-insensitively, with or without spaces (the on-profile handle strips spaces). Returns an empty playerKey when no player has that gamertag.",
    request: z.object({
      gamertag: z.string().min(1).max(60),
    }),
    response: z.object({
      playerKey: z.string(),
      gamertag: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
      const want = norm(args.gamertag);
      if (!want) return { playerKey: "", gamertag: "" };
      const allProfs = await db
        .select({ playerKey: schema.profiles.playerKey, gamertag: schema.profiles.gamertag })
        .from(schema.profiles);
      const hit = allProfs.find((p) => norm(p.gamertag) === want);
      return { playerKey: hit?.playerKey ?? "", gamertag: hit?.gamertag ?? "" };
    },
  }),

  getSocialProfile: defineAction({
    description: "Returns the Instagram-style public profile for one player (the viewer when targetKey is empty): display name, username, bio, avatar, calling card, Level/Rank, crew, event counts, visible linked accounts, crewmates, and the real Posts / Followers / Following counts with the viewer's follow state. Follow data comes from saved profile_follows rows only.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      targetKey: z.string().max(80).default(""),
    }),
    response: z.object({
      found: z.boolean(),
      viewerHasProfile: z.boolean(),
      profile: z
        .object({
          playerKey: z.string(),
          gamertag: z.string(),
          displayName: z.string(),
          bio: z.string(),
          location: z.string(),
          website: z.string(),
          platform: z.string(),
          region: z.string(),
          playstyle: z.string(),
          reputation: z.number(),
          premium: z.boolean(),
          badge: z.string(),
          viceLevel: z.number(),
          vicePoints: z.number(),
          avatarUrl: z.string(),
          avatarEffect: z.string(),
          callingCard: z.string(),
          bannerMediaUrl: z.string(),
          bannerMediaType: z.string(),
          presenceStatus: z.string(),
          customStatus: z.string(),
          memberSince: z.string(),
          ownClanTag: z.string(),
          eventsAttended: z.number(),
          clanId: z.number(),
          clanName: z.string(),
          clanTag: z.string(),
          clanRole: z.string(),
          clanColor: z.string(),
          seasonRank: z.number(),
          topPercent: z.number(),
          isPrivate: z.boolean(),
          links: linksShape,
          friends: z.array(
            z.object({
              playerKey: z.string(),
              gamertag: z.string(),
              role: z.string(),
              platform: z.string(),
              avatarUrl: z.string(),
              avatarEffect: z.string(),
              presence: z.string(),
            }),
          ),
          postsCount: z.number(),
          followersCount: z.number(),
          followingCount: z.number(),
          isMe: z.boolean(),
          viewerFollows: z.boolean(),
          followsViewer: z.boolean(),
          blockedByMe: z.boolean(),
          blocksMe: z.boolean(),
          canViewPosts: z.boolean(),
        })
        .nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const targetKey = args.targetKey.trim() || args.playerKey;
      const allProfs = await db.select().from(schema.profiles);
      const byKey = new Map(allProfs.map((p) => [p.playerKey, p]));
      const viewer = byKey.get(args.playerKey);
      const r = byKey.get(targetKey);
      if (!r) return { found: false, viewerHasProfile: Boolean(viewer), profile: null };
      const isMe = targetKey === args.playerKey;
      const priv = r.profilePrivate === 1 && !isMe;
      const follows = await db.select().from(schema.profileFollows);
      const followersCount = follows.filter((f) => f.followingKey === targetKey).length;
      const followingCount = follows.filter((f) => f.followerKey === targetKey).length;
      const viewerFollows = follows.some((f) => f.followerKey === args.playerKey && f.followingKey === targetKey);
      const followsViewer = follows.some((f) => f.followerKey === targetKey && f.followingKey === args.playerKey);
      // Privacy state for this viewer: a private account's details
      // and posts open up only to its followers; a player who blocked
      // the viewer (or was blocked by them) is fully closed.
      const myBlocks = await blockedKeysFor(ctx, args.playerKey);
      const blockedByMe = !isMe && myBlocks.has(targetKey);
      const theirBlocks = await blockedKeysFor(ctx, targetKey);
      const blocksMe = !isMe && theirBlocks.has(args.playerKey);
      const canViewPosts = isMe || (!blocksMe && !blockedByMe && (r.profilePrivate !== 1 || viewerFollows));
      const privLocked = (priv && !viewerFollows) || blocksMe;
      const feedRows = await db.select().from(schema.feedPosts);
      const postsCount = feedRows.filter((p) => p.authorKey === targetKey && (p.flagged !== 1 || isMe)).length;
      const events = await db.select().from(schema.rankPointEvents);
      const vicePoints = personalPointsOf(events, targetKey);
      const myRsvps = await db.select().from(schema.rsvps).where(eq(schema.rsvps.playerKey, targetKey));
      const eventsAttended = myRsvps.filter((x) => x.status === "Going").length;
      const memberships = await db.select().from(schema.clanMembers).where(eq(schema.clanMembers.playerKey, targetKey));
      const clanId = memberships[0]?.clanId ?? 0;
      const clanRole = memberships[0]?.role ?? "";
      let clanName = "";
      let clanTag = "";
      let clanColor = "";
      let seasonRank = 0;
      let topPercent = 0;
      let friends: {
        playerKey: string; gamertag: string; role: string; platform: string;
        avatarUrl: string; avatarEffect: string; presence: string;
      }[] = [];
      if (clanId) {
        const clanRows = await db.select().from(schema.clans).where(eq(schema.clans.id, clanId));
        clanName = clanRows[0]?.name ?? "";
        clanTag = clanRows[0]?.tag ?? "";
        clanColor = clanRows[0]?.color ?? "";
        const stats = await computeClanRankStats(ctx, seasonKeyOf(new Date()));
        seasonRank = seasonRankMap(stats).get(clanId) ?? 0;
        if (seasonRank > 0 && stats.size > 0) topPercent = Math.max(1, Math.ceil((seasonRank / stats.size) * 100));
        if (!privLocked) {
          const mates = await db.select().from(schema.clanMembers).where(eq(schema.clanMembers.clanId, clanId));
          const art = await avatarArtUrls(ctx);
          const customArt = await customAvatarUrls(ctx);
          friends = mates
            .filter((m) => m.playerKey !== targetKey)
            .map((m) => {
              const p = byKey.get(m.playerKey);
              return {
                playerKey: m.playerKey,
                gamertag: m.gamertag,
                role: m.role,
                platform: p?.platform ?? m.platform,
                avatarUrl: p ? pickAvatar(art, customArt, p) : "",
                avatarEffect: p?.avatarEffect ?? "",
                presence: p ? effectivePresence(p, args.playerKey) : "Offline",
              };
            });
        }
      }
      const art = await avatarArtUrls(ctx);
      // A private Rockstar ID is visible to the player's crew: the
      // viewer counts as crew here when they belong to the target's
      // clan (or are the target themselves).
      const viewerMemberships = isMe || !clanId
        ? []
        : await db.select().from(schema.clanMembers).where(eq(schema.clanMembers.playerKey, args.playerKey));
      const viewerSameCrew = isMe || viewerMemberships.some((m) => m.clanId === clanId);
      return {
        found: true,
        viewerHasProfile: Boolean(viewer),
        profile: {
          playerKey: r.playerKey,
          gamertag: r.gamertag,
          displayName: r.displayName,
          bio: privLocked ? "" : r.bio,
          location: privLocked ? "" : r.location,
          website: privLocked ? "" : r.website,
          platform: r.platform,
          region: privLocked ? "" : r.region,
          playstyle: privLocked ? "" : r.playstyle,
          reputation: r.reputation,
          premium: r.premium === 1,
          badge: r.badge,
          viceLevel: playerLevelFromPoints(vicePoints).level,
          vicePoints,
          avatarUrl: await profileAvatarUrl(ctx, art, r),
          avatarEffect: r.avatarEffect,
          callingCard: r.callingCard,
          bannerMediaUrl: await profileBannerUrl(ctx, r),
          bannerMediaType: r.bannerBlobKey ? r.bannerMediaType : "",
          presenceStatus: effectivePresence(r, args.playerKey),
          customStatus: r.customStatus ?? "",
          memberSince: r.createdAt.toISOString(),
          eventsAttended,
          ownClanTag: r.clanTag,
          clanId,
          clanName,
          clanTag,
          clanRole,
          clanColor,
          seasonRank,
          topPercent,
          isPrivate: r.profilePrivate === 1,
          links: privLocked ? { psn: "", xbox: "", discord: "", rockstar: "", others: [] } : visibleLinks(r, { isSelf: isMe, sameCrew: viewerSameCrew }),
          friends,
          postsCount,
          followersCount,
          followingCount,
          isMe,
          viewerFollows,
          followsViewer,
          blockedByMe,
          blocksMe,
          canViewPosts,
        },
      };
    },
  }),

  getAccountAbout: defineAction({
    description: "The 'About this account' sheet behind the Joined date on a profile (X-style, ViceSunshine design): display name and @username, date joined, account based in (the profile's region — hidden for private accounts from non-followers, like everything else), how many times the username has been changed and when the last change was (tracked for real on every rename; account creation is not a change), how the account is connected (Gmail sign-in for password accounts, otherwise ViceSunshine web), and which gaming networks are linked and visible to this viewer.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      targetKey: z.string().min(1).max(80),
    }),
    response: z.object({
      found: z.boolean(),
      isMe: z.boolean(),
      gamertag: z.string(),
      displayName: z.string(),
      avatarUrl: z.string(),
      memberSince: z.string(),
      region: z.string(),
      usernameChanges: z.number(),
      lastUsernameChangeAt: z.string(),
      connectedVia: z.string(),
      linkedNetworks: z.array(z.string()),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const empty = {
        found: false, isMe: false, gamertag: "", displayName: "", avatarUrl: "",
        memberSince: "", region: "", usernameChanges: 0, lastUsernameChangeAt: "",
        connectedVia: "", linkedNetworks: [] as string[],
      };
      const profs = await db.select().from(schema.profiles);
      const byKey = new Map(profs.map((p) => [p.playerKey, p]));
      const r = byKey.get(args.targetKey);
      if (!r) return empty;
      const isMe = args.targetKey === args.playerKey;
      const follows = await db.select().from(schema.profileFollows);
      const viewerFollows = follows.some((f) => f.followerKey === args.playerKey && f.followingKey === args.targetKey);
      const theirBlocks = await blockedKeysFor(ctx, args.targetKey);
      const blocksMe = !isMe && theirBlocks.has(args.playerKey);
      const regionHidden = (r.profilePrivate === 1 && !isMe && !viewerFollows) || blocksMe;
      const memberships = await db.select().from(schema.clanMembers).where(eq(schema.clanMembers.playerKey, args.targetKey));
      const clanId = memberships[0]?.clanId ?? 0;
      const viewerMemberships = isMe || !clanId
        ? []
        : await db.select().from(schema.clanMembers).where(eq(schema.clanMembers.playerKey, args.playerKey));
      const sameCrew = isMe || viewerMemberships.some((m) => m.clanId === clanId);
      const links = visibleLinks(r, { isSelf: isMe, sameCrew });
      const linkedNetworks = [
        links.psn ? "PlayStation Network" : "",
        links.xbox ? "Xbox" : "",
        links.discord ? "Discord" : "",
        links.rockstar ? "Rockstar Social Club" : "",
        links.others.length > 0 ? "More links" : "",
      ].filter((x) => x !== "");
      const art = await avatarArtUrls(ctx);
      const customArt = await customAvatarUrls(ctx);
      return {
        found: true,
        isMe,
        gamertag: r.gamertag,
        displayName: r.displayName,
        avatarUrl: pickAvatar(art, customArt, r),
        memberSince: r.createdAt.toISOString(),
        region: regionHidden ? "" : r.region,
        usernameChanges: r.usernameChanges ?? 0,
        lastUsernameChangeAt: r.lastUsernameChangeAt ? r.lastUsernameChangeAt.toISOString() : "",
        connectedVia: r.passwordHash ? "Gmail sign-in" : "ViceSunshine web",
        linkedNetworks,
      };
    },
  }),

  setFollow: defineAction({
    description: "Follows or unfollows another ViceSunshine player. Both accounts must be real saved profiles and the viewer must be signed in (have a profile); you cannot follow yourself. Stored as a profile_follows row so counts and lists stay real.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      targetKey: z.string().min(1).max(80),
      follow: z.boolean(),
    }),
    response: z.object({ following: z.boolean(), followersCount: z.number(), followingCount: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (args.targetKey === args.playerKey) throw new Error("You can't follow yourself.");
      const profs = await db.select().from(schema.profiles);
      const viewer = profs.find((p) => p.playerKey === args.playerKey);
      if (!viewer) throw new Error("Create your profile first — following only works when you're signed in.");
      const target = profs.find((p) => p.playerKey === args.targetKey);
      if (!target) throw new Error("That player no longer has a profile.");
      const myBlocks = await blockedKeysFor(ctx, args.playerKey);
      if (args.follow && myBlocks.has(args.targetKey)) throw new Error("You've blocked this player — unblock them in Settings → Permissions to follow them.");
      const theirBlocks = await blockedKeysFor(ctx, args.targetKey);
      if (args.follow && theirBlocks.has(args.playerKey)) throw new Error("You can't follow this player.");
      const existing = await db
        .select()
        .from(schema.profileFollows)
        .where(and(eq(schema.profileFollows.followerKey, args.playerKey), eq(schema.profileFollows.followingKey, args.targetKey)));
      if (args.follow && existing.length === 0) {
        await db.insert(schema.profileFollows).values({ followerKey: args.playerKey, followingKey: args.targetKey });
        // Signed event log: the insights graph's Followers / Following
        // lines are built from these deltas, so they can go down as
        // well as up (the follow row itself is deleted on unfollow).
        await db.insert(schema.followEvents).values({ followerKey: args.playerKey, followingKey: args.targetKey, action: "follow" });
      }
      const existingRow = existing[0];
      if (!args.follow && existingRow) {
        await db.delete(schema.profileFollows).where(eq(schema.profileFollows.id, existingRow.id));
        await db.insert(schema.followEvents).values({ followerKey: args.playerKey, followingKey: args.targetKey, action: "unfollow" });
      }
      const follows = await db.select().from(schema.profileFollows);
      ctx.invalidateQueries();
      return {
        following: follows.some((f) => f.followerKey === args.playerKey && f.followingKey === args.targetKey),
        followersCount: follows.filter((f) => f.followingKey === args.targetKey).length,
        followingCount: follows.filter((f) => f.followerKey === args.targetKey).length,
      };
    },
  }),

  listFollowList: defineAction({
    description: "Lists one player's followers or the players they follow, newest first, with the viewer's own follow state for each row so the list can show Follow / Following / Follow back per person.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      targetKey: z.string().min(1).max(80),
      mode: z.enum(["followers", "following"]),
    }),
    response: z.object({
      items: z.array(
        z.object({
          playerKey: z.string(),
          gamertag: z.string(),
          displayName: z.string(),
          avatarUrl: z.string(),
          avatarEffect: z.string(),
          viceLevel: z.number(),
          premium: z.boolean(),
          isMe: z.boolean(),
          viewerFollows: z.boolean(),
          followsViewer: z.boolean(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const follows = await db.select().from(schema.profileFollows);
      const keys = args.mode === "followers"
        ? follows.filter((f) => f.followingKey === args.targetKey).map((f) => f.followerKey)
        : follows.filter((f) => f.followerKey === args.targetKey).map((f) => f.followingKey);
      const ordered = [...new Set(keys)].reverse();
      const profs = await db.select().from(schema.profiles);
      const byKey = new Map(profs.map((p) => [p.playerKey, p]));
      const events = await db.select().from(schema.rankPointEvents);
      const art = await avatarArtUrls(ctx);
      const customArt = await customAvatarUrls(ctx);
      const items = [];
      for (const k of ordered) {
        const p = byKey.get(k);
        if (!p) continue;
        items.push({
          playerKey: p.playerKey,
          gamertag: p.gamertag,
          displayName: p.displayName,
          avatarUrl: pickAvatar(art, customArt, p),
          avatarEffect: p.avatarEffect,
          viceLevel: playerLevelFromPoints(personalPointsOf(events, p.playerKey)).level,
          premium: p.premium === 1,
          isMe: p.playerKey === args.playerKey,
          viewerFollows: follows.some((f) => f.followerKey === args.playerKey && f.followingKey === p.playerKey),
          followsViewer: follows.some((f) => f.followerKey === p.playerKey && f.followingKey === args.playerKey),
        });
      }
      return { items };
    },
  }),

  getProfileSuggestions: defineAction({
    description: "Instagram-style 'Suggested for you' for one player: real profiles they don't follow yet, ranked by relevance from their own stored data — same crew first, then people followed by people they follow, then authors whose posts they liked or commented on, then same region / platform — with any remaining slots filled by the most-followed profiles in the community. Each suggestion carries the plain reason it was picked. The player themself, people they already follow, and people they blocked are never suggested. Per-user search history is not stored anywhere, so searches play no part — nothing here is guessed.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({
      items: z.array(
        z.object({
          playerKey: z.string(),
          gamertag: z.string(),
          displayName: z.string(),
          avatarUrl: z.string(),
          reason: z.string(),
          followers: z.number(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profs = await db.select().from(schema.profiles);
      const me = profs.find((p) => p.playerKey === args.playerKey);
      if (!me) return { items: [] };
      const [follows, members, clans, reactions, comments, posts, blocked] = await Promise.all([
        db.select().from(schema.profileFollows),
        db.select().from(schema.clanMembers),
        db.select().from(schema.clans),
        db.select().from(schema.feedReactions),
        db.select().from(schema.feedComments),
        db.select().from(schema.feedPosts),
        db.select().from(schema.blockedUsers),
      ]);
      const myFollowing = new Set(follows.filter((f) => f.followerKey === args.playerKey).map((f) => f.followingKey));
      const blockedKeys = new Set(blocked.filter((b) => b.playerKey === args.playerKey).map((b) => b.blockedKey));
      const followersOf = new Map<string, number>();
      for (const f of follows) followersOf.set(f.followingKey, (followersOf.get(f.followingKey) ?? 0) + 1);
      // My crews and who is in them.
      const myClanIds = new Set(members.filter((m) => m.playerKey === args.playerKey).map((m) => m.clanId));
      const clanNameOf = new Map(clans.map((c) => [c.id, c.name]));
      const crewMates = new Map<string, string>();
      for (const m of members) {
        if (m.playerKey !== args.playerKey && myClanIds.has(m.clanId)) {
          crewMates.set(m.playerKey, clanNameOf.get(m.clanId) ?? "");
        }
      }
      // People followed by people I follow.
      const secondDegree = new Set(
        follows.filter((f) => myFollowing.has(f.followerKey)).map((f) => f.followingKey),
      );
      // Authors whose posts I liked or commented on.
      const engagedAuthors = new Set<string>();
      const postAuthorOf = new Map(posts.map((p) => [p.id, p.authorKey]));
      for (const r of reactions) {
        if (r.playerKey === args.playerKey) {
          const a = postAuthorOf.get(r.postId);
          if (a && a !== args.playerKey) engagedAuthors.add(a);
        }
      }
      for (const c of comments) {
        if (c.authorKey === args.playerKey) {
          const a = postAuthorOf.get(c.postId);
          if (a && a !== args.playerKey) engagedAuthors.add(a);
        }
      }
      const art = await avatarArtUrls(ctx);
      const customArt = await customAvatarUrls(ctx);
      type Scored = { p: (typeof profs)[number]; score: number; reason: string };
      const scored: Scored[] = [];
      const popular: Scored[] = [];
      for (const p of profs) {
        if (p.playerKey === args.playerKey) continue;
        if (myFollowing.has(p.playerKey)) continue;
        if (blockedKeys.has(p.playerKey)) continue;
        let score = 0;
        let reason = "";
        const crewName = crewMates.get(p.playerKey);
        if (crewName !== undefined) { score += 6; reason = crewName ? `In your crew · ${crewName}` : "In your crew"; }
        if (secondDegree.has(p.playerKey)) { score += 4; if (!reason) reason = "Followed by people you follow"; }
        if (engagedAuthors.has(p.playerKey)) { score += 3; if (!reason) reason = "You liked their posts"; }
        if (me.region && p.region && p.region === me.region) { score += 1; if (!reason) reason = `Also in ${p.region}`; }
        if (p.platform === me.platform) { score += 1; if (!reason) reason = `Also on ${p.platform}`; }
        if (score > 0) scored.push({ p, score, reason });
        else popular.push({ p, score: 0, reason: "Popular in the community" });
      }
      const byRank = (a: Scored, b: Scored) =>
        b.score - a.score || (followersOf.get(b.p.playerKey) ?? 0) - (followersOf.get(a.p.playerKey) ?? 0);
      scored.sort(byRank);
      popular.sort(byRank);
      const picked = [...scored, ...popular].slice(0, 8);
      return {
        items: picked.map(({ p, reason }) => ({
          playerKey: p.playerKey,
          gamertag: p.gamertag,
          displayName: p.displayName,
          avatarUrl: pickAvatar(art, customArt, p),
          reason,
          followers: followersOf.get(p.playerKey) ?? 0,
        })),
      };
    },
  }),

  listProfilePosts: defineAction({
    description: "Lists Feed posts for one player's Instagram-style profile grid tabs, newest first. Modes: 'posts' = their own posts; 'clips' = only their video posts; 'reposts' = posts they reposted (the repost rows they authored); 'tagged' = other players' posts whose title or body mentions their gamertag. Flagged posts are hidden from everyone except their author, and blocked authors are hidden from the viewer.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      targetKey: z.string().min(1).max(80),
      mode: z.enum(["posts", "clips", "reposts", "tagged"]).default("posts"),
    }),
    response: z.object({ items: z.array(profilePostItem) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let rows = await db.select().from(schema.feedPosts).orderBy(desc(schema.feedPosts.id));
      const blockedSet = await blockedKeysFor(ctx, args.playerKey);
      if (args.mode === "tagged") {
        const profs = await db.select().from(schema.profiles);
        const tag = profs.find((p) => p.playerKey === args.targetKey)?.gamertag.toLowerCase() ?? "";
        rows = rows.filter((r) => r.authorKey !== args.targetKey);
        rows = rows.filter((r) => r.flagged !== 1);
        rows = rows.filter((r) => !blockedSet.has(r.authorKey));
        if (tag) {
          rows = rows.filter((r) => r.title.toLowerCase().includes(tag) || r.body.toLowerCase().includes(tag));
        } else rows = [];
        return { items: await profilePostItems(ctx, rows.slice(0, 60), args.playerKey) };
      }
      rows = rows.filter((r) => r.authorKey === args.targetKey);
      rows = rows.filter((r) => r.flagged !== 1 || r.authorKey === args.playerKey);
      if (args.targetKey !== args.playerKey && blockedSet.has(args.targetKey)) rows = [];
      if (args.targetKey !== args.playerKey) {
        // A player who blocked the viewer shows them nothing, and a
        // private account's posts are only for its followers.
        const blockedBySet = await blockedByKeysFor(ctx, args.playerKey);
        if (blockedBySet.has(args.targetKey)) rows = [];
        const targetProfile = (await db.select().from(schema.profiles).where(eq(schema.profiles.playerKey, args.targetKey)))[0];
        if (targetProfile && targetProfile.profilePrivate === 1) {
          const followsTarget = await db
            .select()
            .from(schema.profileFollows)
            .where(and(eq(schema.profileFollows.followerKey, args.playerKey), eq(schema.profileFollows.followingKey, args.targetKey)));
          if (followsTarget.length === 0) rows = [];
        }
      }
      if (args.mode === "reposts") {
        rows = rows.filter((r) => r.repostOfId !== 0);
      }
      if (args.mode === "posts") {
        rows = rows.filter((r) => r.repostOfId === 0);
      }
      if (args.mode === "clips") {
        rows = rows.filter((r) => {
          const m = feedMediaOf(r.mediaUrl);
          return m.mediaType === "youtube" || m.mediaType === "video" || ["Clip", "Streamer Clip", "Gameplay", "Tutorial"].includes(r.kind);
        });
      }
      return { items: await profilePostItems(ctx, rows.slice(0, 60), args.playerKey) };
    },
  }),

  listStoryArchive: defineAction({
    description: "Returns the player's own story archive for the profile's View archive sheet: every story they ever posted (live ones flagged live, older ones expired after 24 hours), newest first, with view and like counts. Only ever the player's own stories.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({
      items: z.array(z.object({
        id: z.number(), mediaUrl: z.string(), mediaType: z.string(), text: z.string(), sticker: z.string(),
        createdAt: z.string(), live: z.boolean(), views: z.number(), likes: z.number(),
      })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = (await db.select().from(schema.stories).orderBy(desc(schema.stories.id)))
        .filter((r) => r.authorKey === args.playerKey);
      const viewRows = await db.select().from(schema.storyViews);
      const likeRows = await db.select().from(schema.storyLikes);
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      return {
        items: rows.slice(0, 60).map((r) => ({
          id: r.id, mediaUrl: r.mediaUrl, mediaType: storyMediaTypeOf(r.mediaType, r.mediaUrl), text: r.text, sticker: r.sticker,
          createdAt: r.createdAt.toISOString(), live: r.createdAt.getTime() > cutoff,
          views: viewRows.filter((v) => v.storyId === r.id).length,
          likes: likeRows.filter((v) => v.storyId === r.id).length,
        })),
      };
    },
  }),

  listHighlights: defineAction({
    description: "Lists one player's Story Highlights for their profile highlights row: each highlight's title, cover (its first story's picture), story count, and the full ordered stories so tapping the circle plays them in the story viewer. Highlight stories stay viewable past the 24-hour story window — that is the point of a highlight. Only the highlight owner's own stories can be in a highlight (enforced when highlights are created / edited).",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      targetKey: z.string().min(1).max(80),
    }),
    response: z.object({
      items: z.array(z.object({
        id: z.number(),
        title: z.string(),
        coverUrl: z.string(),
        coverMediaType: z.string(),
        storyCount: z.number(),
        stories: z.array(z.object({
          id: z.number(), mediaUrl: z.string(), mediaType: z.string(), text: z.string(), sticker: z.string(), createdAt: z.string(),
          expiresAt: z.string(), views: z.number(), likes: z.number(), likedByMe: z.boolean(), mine: z.boolean(),
        })),
      })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const highlights = (await db.select().from(schema.storyHighlights).orderBy(asc(schema.storyHighlights.id)))
        .filter((h) => h.playerKey === args.targetKey);
      if (highlights.length === 0) return { items: [] };
      // Private accounts (owner's rule): highlights are the
      // account's stories too, so they are only for players the
      // account has accepted as followers — a non-follower gets
      // nothing here and sees the locked profile instead. A player
      // the owner blocked likewise gets nothing.
      if (args.targetKey !== args.playerKey) {
        const blockedBySet = await blockedByKeysFor(ctx, args.playerKey);
        if (blockedBySet.has(args.targetKey)) return { items: [] };
        const targetProfile = (await db.select().from(schema.profiles).where(eq(schema.profiles.playerKey, args.targetKey)))[0];
        if (targetProfile && targetProfile.profilePrivate === 1) {
          const followsTarget = await db
            .select()
            .from(schema.profileFollows)
            .where(and(eq(schema.profileFollows.followerKey, args.playerKey), eq(schema.profileFollows.followingKey, args.targetKey)));
          if (followsTarget.length === 0) return { items: [] };
        }
      }
      const itemRows = await db.select().from(schema.storyHighlightItems).orderBy(asc(schema.storyHighlightItems.id));
      const storyRows = await db.select().from(schema.stories);
      const storyById = new Map(storyRows.map((s) => [s.id, s]));
      const viewRows = await db.select().from(schema.storyViews);
      const likeRows = await db.select().from(schema.storyLikes);
      const items = highlights.map((h) => {
        const stories = itemRows
          .filter((i) => i.highlightId === h.id)
          .map((i) => storyById.get(i.storyId))
          .filter((s): s is NonNullable<typeof s> => Boolean(s) && s!.authorKey === args.targetKey)
          .map((s) => ({
            id: s.id, mediaUrl: s.mediaUrl, mediaType: storyMediaTypeOf(s.mediaType, s.mediaUrl), text: s.text, sticker: s.sticker,
            createdAt: s.createdAt.toISOString(),
            expiresAt: new Date(s.createdAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
            // Views are the poster's private number (Instagram
            // rule): only filled in when the viewer IS the author.
            views: s.authorKey === args.playerKey ? viewRows.filter((v) => v.storyId === s.id).length : 0,
            likes: likeRows.filter((v) => v.storyId === s.id).length,
            likedByMe: likeRows.some((v) => v.storyId === s.id && v.playerKey === args.playerKey),
            mine: s.authorKey === args.playerKey,
          }));
        const cover = stories.find((s) => s.mediaType === "image" && s.mediaUrl) ?? stories[0];
        return {
          id: h.id,
          title: h.title,
          coverUrl: cover?.mediaUrl ?? "",
          coverMediaType: cover?.mediaType ?? "",
          storyCount: stories.length,
          stories,
        };
      }).filter((h) => h.storyCount > 0);
      return { items };
    },
  }),

  createHighlight: defineAction({
    description: "Creates a Story Highlight on the player's own profile from their own stories (live or archived — the picker uses the story archive): a title plus 1–30 of their story ids, kept in the order picked. The stories stay viewable inside the highlight after their 24 hours are up.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      title: z.string().trim().min(1).max(40),
      storyIds: z.array(z.number().int().positive()).min(1).max(30),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      assertClean(args.title);
      const prof = (await db.select().from(schema.profiles).where(eq(schema.profiles.playerKey, args.playerKey)))[0];
      if (!prof) throw new Error("Create your profile first — then you can pin story highlights to it.");
      const storyRows = await db.select().from(schema.stories);
      const mine = new Map(storyRows.filter((s) => s.authorKey === args.playerKey).map((s) => [s.id, s]));
      const ids = [...new Set(args.storyIds)].filter((id) => mine.has(id));
      if (ids.length === 0) throw new Error("Pick at least one of your own stories for this highlight.");
      const res = await db
        .insert(schema.storyHighlights)
        .values({ playerKey: args.playerKey, title: args.title })
        .returning({ id: schema.storyHighlights.id });
      const highlightId = res[0]?.id ?? 0;
      for (const storyId of ids) {
        await db.insert(schema.storyHighlightItems).values({ highlightId, storyId });
      }
      ctx.invalidateQueries();
      return { id: highlightId };
    },
  }),

  updateHighlight: defineAction({
    description: "Edits one of the player's own Story Highlights: renames it and/or replaces its story set with the picked stories (their own stories only, kept in the order picked). Deleting every story is not an edit — use deleteHighlight for that.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      highlightId: z.number().int().positive(),
      title: z.string().trim().min(1).max(40).optional(),
      storyIds: z.array(z.number().int().positive()).min(1).max(30).optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const h = (await db.select().from(schema.storyHighlights).where(eq(schema.storyHighlights.id, args.highlightId)))[0];
      if (!h || h.playerKey !== args.playerKey) throw new Error("That highlight isn't yours to edit.");
      if (args.title !== undefined) {
        assertClean(args.title);
        await db.update(schema.storyHighlights).set({ title: args.title }).where(eq(schema.storyHighlights.id, h.id));
      }
      if (args.storyIds !== undefined) {
        const storyRows = await db.select().from(schema.stories);
        const mine = new Set(storyRows.filter((s) => s.authorKey === args.playerKey).map((s) => s.id));
        const ids = [...new Set(args.storyIds)].filter((id) => mine.has(id));
        if (ids.length === 0) throw new Error("Pick at least one of your own stories — or delete the highlight instead.");
        await db.delete(schema.storyHighlightItems).where(eq(schema.storyHighlightItems.highlightId, h.id));
        for (const storyId of ids) {
          await db.insert(schema.storyHighlightItems).values({ highlightId: h.id, storyId });
        }
      }
      ctx.invalidateQueries();
      return ok();
    },
  }),

  deleteHighlight: defineAction({
    description: "Deletes one of the player's own Story Highlights from their profile. The stories themselves are NOT deleted — they stay in the player's story archive; only the highlight collection goes.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      highlightId: z.number().int().positive(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const h = (await db.select().from(schema.storyHighlights).where(eq(schema.storyHighlights.id, args.highlightId)))[0];
      if (!h || h.playerKey !== args.playerKey) throw new Error("That highlight isn't yours to delete.");
      await db.delete(schema.storyHighlightItems).where(eq(schema.storyHighlightItems.highlightId, h.id));
      await db.delete(schema.storyHighlights).where(eq(schema.storyHighlights.id, h.id));
      ctx.invalidateQueries();
      return ok();
    },
  }),


  listDmConversations: defineAction({
    description: "Lists the player's Instagram-style direct-message conversations: one row per person they have exchanged messages with, pinned chats first then most recent, with the last message preview, its time, the unread count, and whether it is a request (someone they do not follow messaged first and they have never replied). Also returns the Notes row: the player's own note (their custom status) plus notes from people they follow and their crewmates.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      search: z.string().trim().max(80).default(""),
    }),
    response: z.object({
      hasProfile: z.boolean(),
      myNote: z.string(),
      notes: z.array(z.object({
        playerKey: z.string(), gamertag: z.string(), avatarUrl: z.string(), avatarEffect: z.string(), note: z.string(),
      })),
      items: z.array(z.object({
        otherKey: z.string(), gamertag: z.string(), displayName: z.string(), avatarUrl: z.string(), avatarEffect: z.string(),
        presence: z.string(), lastBody: z.string(), lastAt: z.string(), lastMine: z.boolean(),
        unread: z.number(), pinned: z.boolean(), request: z.boolean(),
      })),
      groups: z.array(z.object({
        groupId: z.number(), kind: z.string(), name: z.string(), clanId: z.number(),
        memberCount: z.number(), lastBody: z.string(), lastAt: z.string(), lastMine: z.boolean(),
        unread: z.number(), isLeader: z.boolean(), eventId: z.number(), eventStartsAt: z.string(),
        clanTag: z.string(), clanColor: z.string(), clanEmblem: z.string(), clanCard: z.string(),
        clanPlatform: z.string(), clanPrivacy: z.string(), clanRegion: z.string(),
      })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profs = await db.select().from(schema.profiles);
      const byKey = new Map(profs.map((p) => [p.playerKey, p]));
      const me = byKey.get(args.playerKey);
      if (!me) return { hasProfile: false, myNote: "", notes: [], items: [], groups: [] };
      await ensureCrewChats(ctx, args.playerKey);
      await ensureEventChats(ctx, args.playerKey);
      const art = await avatarArtUrls(ctx);
      const customArt = await customAvatarUrls(ctx);
      const follows = await db.select().from(schema.profileFollows);
      const iFollow = new Set(follows.filter((f) => f.followerKey === args.playerKey).map((f) => f.followingKey));
      const myCrews = await db.select().from(schema.clanMembers).where(eq(schema.clanMembers.playerKey, args.playerKey));
      const crewIds = new Set(myCrews.map((m) => m.clanId));
      const allMembers = crewIds.size ? await db.select().from(schema.clanMembers) : [];
      const crewmateKeys = new Set(allMembers.filter((m) => crewIds.has(m.clanId) && m.playerKey !== args.playerKey).map((m) => m.playerKey));
      const noteKeys = [...new Set([...iFollow, ...crewmateKeys])];
      const notes = noteKeys
        .map((k) => byKey.get(k))
        .filter((p): p is NonNullable<typeof p> => Boolean(p && (p.customStatus ?? "").trim()))
        .map((p) => ({
          playerKey: p.playerKey, gamertag: p.gamertag,
          avatarUrl: pickAvatar(art, customArt, p), avatarEffect: p.avatarEffect,
          note: (p.customStatus ?? "").trim(),
        }));
      const msgs = await db.select().from(schema.directMessages).orderBy(asc(schema.directMessages.id));
      const mine = msgs.filter((m) => m.groupId === 0 && (m.senderKey === args.playerKey || m.recipientKey === args.playerKey));
      const pins = await db.select().from(schema.dmPins).where(eq(schema.dmPins.playerKey, args.playerKey));
      const pinSet = new Set(pins.map((p) => p.otherKey));
      const byOther = new Map<string, typeof mine>();
      for (const m of mine) {
        const other = m.senderKey === args.playerKey ? m.recipientKey : m.senderKey;
        byOther.set(other, [...(byOther.get(other) ?? []), m]);
      }
      const q = args.search.trim().toLowerCase();
      const items = [...byOther.entries()]
        .map(([otherKey, list]) => {
          const p = byKey.get(otherKey);
          const last = list[list.length - 1];
          const iReplied = list.some((m) => m.senderKey === args.playerKey);
          return {
            otherKey,
            gamertag: p?.gamertag ?? "Player",
            displayName: p?.displayName ?? "",
            avatarUrl: p ? pickAvatar(art, customArt, p) : "",
            avatarEffect: p?.avatarEffect ?? "",
            presence: p ? effectivePresence(p, args.playerKey) : "Offline",
            lastBody: last?.body ?? "",
            lastAt: last?.createdAt.toISOString() ?? "",
            lastMine: last?.senderKey === args.playerKey,
            unread: list.filter((m) => m.recipientKey === args.playerKey && m.seen !== 1).length,
            pinned: pinSet.has(otherKey),
            request: !iFollow.has(otherKey) && !iReplied && list.some((m) => m.senderKey === otherKey),
          };
        })
        .filter((i) => !q || i.gamertag.toLowerCase().includes(q) || i.displayName.toLowerCase().includes(q) || i.lastBody.toLowerCase().includes(q))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastAt > a.lastAt ? 1 : b.lastAt < a.lastAt ? -1 : 0));
      // Group + crew chats the player belongs to (crew chats were
      // just synced by ensureCrewChats above). Unread for a group
      // counts messages past the member's own read marker.
      const myGroupRows = await db.select().from(schema.chatGroupMembers).where(eq(schema.chatGroupMembers.playerKey, args.playerKey));
      const myGroupIds = new Set(myGroupRows.map((r) => r.groupId));
      const allGroups = (await db.select().from(schema.chatGroups)).filter((g) => myGroupIds.has(g.id));
      const allGroupMembers = await db.select().from(schema.chatGroupMembers);
      const memberCountOf = new Map<number, number>();
      for (const r of allGroupMembers) memberCountOf.set(r.groupId, (memberCountOf.get(r.groupId) ?? 0) + 1);
      const clanRowsForChat = await db.select().from(schema.clans);
      const clanByIdForChat = new Map(clanRowsForChat.map((c) => [c.id, c]));
      const eventRowsForChat = await db.select().from(schema.events);
      const eventByIdForChat = new Map(eventRowsForChat.map((e) => [e.id, e]));
      const groups = allGroups
        .map((g) => {
          const clan = g.kind === "crew" ? clanByIdForChat.get(g.clanId ?? 0) : undefined;
          const list = msgs.filter((m) => m.groupId === g.id);
          const last = list[list.length - 1];
          const myRow = myGroupRows.find((r) => r.groupId === g.id);
          return {
            groupId: g.id,
            kind: g.kind,
            name: g.name,
            clanId: g.clanId ?? 0,
            eventId: g.eventId ?? 0,
            eventStartsAt: g.kind === "event" ? eventByIdForChat.get(g.eventId ?? 0)?.startsAt ?? "" : "",
            memberCount: memberCountOf.get(g.id) ?? 0,
            lastBody: last?.body ?? "",
            lastAt: last?.createdAt.toISOString() ?? g.createdAt.toISOString(),
            lastMine: last?.senderKey === args.playerKey,
            unread: list.filter((m) => m.id > (myRow?.lastReadId ?? 0) && m.senderKey !== args.playerKey).length,
            isLeader: g.ownerKey === args.playerKey,
            clanTag: clan?.tag ?? "",
            clanColor: clan?.color ?? "",
            clanEmblem: clan?.emblem ?? "",
            clanCard: clan?.callingCard ?? "",
            clanPlatform: clan?.platform ?? "",
            clanPrivacy: clan?.privacy ?? "",
            clanRegion: clan?.region ?? "",
          };
        })
        .filter((g) => !q || g.name.toLowerCase().includes(q) || g.lastBody.toLowerCase().includes(q))
        .sort((a, b) => (b.lastAt > a.lastAt ? 1 : b.lastAt < a.lastAt ? -1 : 0));
      return { hasProfile: true, myNote: (me.customStatus ?? "").trim(), notes, items, groups };
    },
  }),

  listDmThread: defineAction({
    description: "Returns one direct-message conversation (both directions, oldest first) and marks the other person's messages as seen for the reader. Also returns the other player's public profile summary for the conversation header.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      otherKey: z.string().min(1).max(80),
    }),
    response: z.object({
      other: z.object({
        playerKey: z.string(), gamertag: z.string(), displayName: z.string(), avatarUrl: z.string(), avatarEffect: z.string(), presence: z.string(),
      }).nullable(),
      messages: z.array(z.object({
        id: z.number(), mine: z.boolean(), body: z.string(), createdAt: z.string(), seen: z.boolean(),
      })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profs = await db.select().from(schema.profiles);
      const byKey = new Map(profs.map((p) => [p.playerKey, p]));
      const otherP = byKey.get(args.otherKey);
      const art = await avatarArtUrls(ctx);
      const customArt = await customAvatarUrls(ctx);
      const rows = (await db.select().from(schema.directMessages).orderBy(asc(schema.directMessages.id)))
        .filter((m) => m.groupId === 0 && ((m.senderKey === args.playerKey && m.recipientKey === args.otherKey) || (m.senderKey === args.otherKey && m.recipientKey === args.playerKey)));
      const unseen = rows.filter((m) => m.recipientKey === args.playerKey && m.seen !== 1);
      for (const m of unseen) {
        await db.update(schema.directMessages).set({ seen: 1 }).where(eq(schema.directMessages.id, m.id));
      }
      if (unseen.length) ctx.invalidateQueries();
      return {
        other: otherP ? {
          playerKey: otherP.playerKey, gamertag: otherP.gamertag, displayName: otherP.displayName,
          avatarUrl: pickAvatar(art, customArt, otherP), avatarEffect: otherP.avatarEffect,
          presence: effectivePresence(otherP, args.playerKey),
        } : null,
        messages: rows.map((m) => ({
          id: m.id, mine: m.senderKey === args.playerKey, body: m.body,
          createdAt: m.createdAt.toISOString(), seen: m.seen === 1 || unseen.some((u) => u.id === m.id),
        })),
      };
    },
  }),

  sendDm: defineAction({
    description: "Sends a private direct message to another ViceSunshine player. Both players must have real profiles, you cannot message yourself, and blocked players are refused. Private DMs are never screened or monitored — automatic moderation covers public content only (profiles, posts, comments, shared crew/group spaces).",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      otherKey: z.string().min(1).max(80),
      body: z.string().trim().min(1).max(1000),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (args.otherKey === args.playerKey) throw new Error("You can't message yourself.");
      // Private one-to-one DMs are NOT screened or monitored
      // (owner's direction): automatic moderation covers public
      // content only — profiles, Feed posts, comments, stories,
      // crew and group spaces — never private messages.
      const profs = await db.select().from(schema.profiles);
      if (!profs.some((p) => p.playerKey === args.playerKey)) throw new Error("Create your profile first — messaging only works when you're signed in.");
      if (!profs.some((p) => p.playerKey === args.otherKey)) throw new Error("That player no longer has a profile.");
      const blockedSet = await blockedKeysFor(ctx, args.playerKey);
      if (blockedSet.has(args.otherKey)) throw new Error("You've blocked this player — unblock them in Settings to message them.");
      const theirBlocked = await blockedKeysFor(ctx, args.otherKey);
      if (theirBlocked.has(args.playerKey)) throw new Error("This player isn't accepting messages from you.");
      const res = await db.insert(schema.directMessages).values({
        senderKey: args.playerKey, recipientKey: args.otherKey, body: args.body,
      }).returning({ id: schema.directMessages.id });
      ctx.invalidateQueries();
      return { id: res[0]?.id ?? 0 };
    },
  }),

  toggleDmPin: defineAction({
    description: "Pins or unpins a direct-message conversation in the player's own Messages list (pinned chats sit on top). Only affects the player's own list.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      otherKey: z.string().min(1).max(80),
      pinned: z.boolean(),
    }),
    response: z.object({ pinned: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.dmPins)
        .where(and(eq(schema.dmPins.playerKey, args.playerKey), eq(schema.dmPins.otherKey, args.otherKey)));
      const row = existing[0];
      if (args.pinned && !row) {
        await db.insert(schema.dmPins).values({ playerKey: args.playerKey, otherKey: args.otherKey });
      }
      if (!args.pinned && row) {
        await db.delete(schema.dmPins).where(eq(schema.dmPins.id, row.id));
      }
      ctx.invalidateQueries();
      return { pinned: args.pinned };
    },
  }),

  listGroupThread: defineAction({
    description: "Returns one group or crew chat: its details, member list and messages (oldest first), and advances the reader's own read marker so its unread count clears. Only members can read a chat.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      groupId: z.number().int().positive(),
    }),
    response: z.object({
      group: z.object({
        id: z.number(), name: z.string(), kind: z.string(), clanId: z.number(),
        memberCount: z.number(), isLeader: z.boolean(), eventId: z.number(), eventStartsAt: z.string(),
        clanTag: z.string(), clanColor: z.string(), clanEmblem: z.string(), clanCard: z.string(),
        clanPlatform: z.string(), clanPrivacy: z.string(), clanRegion: z.string(),
        members: z.array(z.object({
          playerKey: z.string(), gamertag: z.string(), displayName: z.string(), avatarUrl: z.string(), isLeader: z.boolean(), muted: z.boolean(),
        })),
      }).nullable(),
      messages: z.array(z.object({
        id: z.number(), mine: z.boolean(), senderKey: z.string(), senderName: z.string(), body: z.string(), createdAt: z.string(),
      })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await ensureCrewChats(ctx, args.playerKey);
      await ensureEventChats(ctx, args.playerKey);
      const groups = await db.select().from(schema.chatGroups).where(eq(schema.chatGroups.id, args.groupId));
      const g = groups[0];
      if (!g) return { group: null, messages: [] };
      const memberRows = await db.select().from(schema.chatGroupMembers).where(eq(schema.chatGroupMembers.groupId, g.id));
      const mine = memberRows.find((r) => r.playerKey === args.playerKey);
      if (!mine) return { group: null, messages: [] };
      const profs = await db.select().from(schema.profiles);
      const byKey = new Map(profs.map((p) => [p.playerKey, p]));
      const art = await avatarArtUrls(ctx);
      const customArt = await customAvatarUrls(ctx);
      const rows = (await db.select().from(schema.directMessages).orderBy(asc(schema.directMessages.id)))
        .filter((m) => m.groupId === g.id);
      const maxId = rows.length ? rows[rows.length - 1]!.id : 0;
      if (maxId > mine.lastReadId) {
        await db.update(schema.chatGroupMembers).set({ lastReadId: maxId }).where(eq(schema.chatGroupMembers.id, mine.id));
        ctx.invalidateQueries();
      }
      const clanForChat = g.kind === "crew" ? (await db.select().from(schema.clans)).find((c) => c.id === (g.clanId ?? 0)) : undefined;
      const eventForChat = g.kind === "event" ? (await db.select().from(schema.events)).find((e) => e.id === (g.eventId ?? 0)) : undefined;
      const orderedMemberRows = [...memberRows].sort((a, b) => (g.ownerKey === a.playerKey ? 0 : 1) - (g.ownerKey === b.playerKey ? 0 : 1) || a.id - b.id);
      return {
        group: {
          id: g.id, name: g.name, kind: g.kind, clanId: g.clanId ?? 0,
          eventId: g.eventId ?? 0, eventStartsAt: eventForChat?.startsAt ?? "",
          memberCount: memberRows.length, isLeader: g.ownerKey === args.playerKey,
          clanTag: clanForChat?.tag ?? "",
          clanColor: clanForChat?.color ?? "",
          clanEmblem: clanForChat?.emblem ?? "",
          clanCard: clanForChat?.callingCard ?? "",
          clanPlatform: clanForChat?.platform ?? "",
          clanPrivacy: clanForChat?.privacy ?? "",
          clanRegion: clanForChat?.region ?? "",
          members: orderedMemberRows.map((r) => {
            const p = byKey.get(r.playerKey);
            return {
              playerKey: r.playerKey,
              gamertag: p?.gamertag ?? "Player",
              displayName: p?.displayName ?? "",
              avatarUrl: p ? pickAvatar(art, customArt, p) : "",
              isLeader: g.ownerKey === r.playerKey,
              muted: r.muted === 1,
            };
          }),
        },
        messages: rows.map((m) => ({
          id: m.id, mine: m.senderKey === args.playerKey, senderKey: m.senderKey,
          senderName: byKey.get(m.senderKey)?.displayName.trim() || byKey.get(m.senderKey)?.gamertag || "Player",
          body: m.body, createdAt: m.createdAt.toISOString(),
        })),
      };
    },
  }),

  sendGroupMessage: defineAction({
    description: "Sends a message into a group or crew chat the player belongs to. Group and crew chats are shared community spaces, so the text passes the same automatic safety check as Feed posts (only private one-to-one DMs are unscreened).",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      groupId: z.number().int().positive(),
      body: z.string().trim().min(1).max(1000),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      assertClean(args.body);
      const memberRows = await db.select().from(schema.chatGroupMembers)
        .where(and(eq(schema.chatGroupMembers.groupId, args.groupId), eq(schema.chatGroupMembers.playerKey, args.playerKey)));
      if (!memberRows[0]) throw new Error("You're not a member of that chat.");
      if (memberRows[0].muted === 1) {
        throw new Error("The leader has muted you in this chat — you can read everything, but you can't send messages here until they unmute you.");
      }
      const res = await db.insert(schema.directMessages).values({
        senderKey: args.playerKey, recipientKey: "", body: args.body, groupId: args.groupId,
      }).returning({ id: schema.directMessages.id });
      ctx.invalidateQueries();
      return { id: res[0]?.id ?? 0 };
    },
  }),

  createGroupChat: defineAction({
    description: "Creates a group chat. The creator can add ANYONE they follow (any crew, no crew — following is the only rule), up to 30 people; the creator owns the group. Crew chats are separate and automatic — this is only for player-made groups.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      name: z.string().trim().max(60).default(""),
      memberKeys: z.array(z.string().min(1).max(80)).min(1).max(30),
    }),
    response: z.object({ groupId: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profs = await db.select().from(schema.profiles);
      const byKey = new Map(profs.map((p) => [p.playerKey, p]));
      const me = byKey.get(args.playerKey);
      if (!me) throw new Error("Create your profile first — group chats only work when you're signed in.");
      const follows = await db.select().from(schema.profileFollows);
      const iFollow = new Set(follows.filter((f) => f.followerKey === args.playerKey).map((f) => f.followingKey));
      const keys = [...new Set(args.memberKeys)].filter((k) => k !== args.playerKey);
      if (keys.length === 0) throw new Error("Pick at least one person you follow for the group chat.");
      for (const k of keys) {
        if (!byKey.get(k)) throw new Error("One of those players no longer has a profile.");
        if (!iFollow.has(k)) throw new Error("You can only add people you follow to a group chat.");
      }
      const name = args.name.trim() || [me.gamertag, ...keys.map((k) => byKey.get(k)?.gamertag ?? "")].join(", ").slice(0, 60);
      const res = await db.insert(schema.chatGroups).values({
        kind: "group", name, clanId: null, ownerKey: args.playerKey,
      }).returning({ id: schema.chatGroups.id });
      const gid = res[0]?.id ?? 0;
      await db.insert(schema.chatGroupMembers).values({ groupId: gid, playerKey: args.playerKey });
      for (const k of keys) {
        await db.insert(schema.chatGroupMembers).values({ groupId: gid, playerKey: k });
      }
      ctx.invalidateQueries();
      return { groupId: gid };
    },
  }),

  leaveGroupChat: defineAction({
    description: "Leaves a player-made group chat. Crew chats cannot be left directly — leaving the crew leaves its chat automatically. If the group's owner leaves, ownership passes to the longest-standing remaining member; the last leaver deletes the group.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      groupId: z.number().int().positive(),
    }),
    response: z.object({ left: z.literal(true) }),
    async handler(ctx, args): Promise<{ left: true }> {
      const db = ctx.db<typeof schema>();
      const groups = await db.select().from(schema.chatGroups).where(eq(schema.chatGroups.id, args.groupId));
      const g = groups[0];
      if (!g) throw new Error("That chat no longer exists.");
      if (g.kind === "crew") throw new Error("Crew chats follow your crew — leave the crew to leave its chat.");
      const rows = await db.select().from(schema.chatGroupMembers).where(eq(schema.chatGroupMembers.groupId, g.id));
      const mine = rows.find((r) => r.playerKey === args.playerKey);
      if (!mine) throw new Error("You're not a member of that chat.");
      await db.delete(schema.chatGroupMembers).where(eq(schema.chatGroupMembers.id, mine.id));
      const rest = rows.filter((r) => r.id !== mine.id);
      if (rest.length === 0) {
        await db.delete(schema.directMessages).where(eq(schema.directMessages.groupId, g.id));
        await db.delete(schema.chatGroups).where(eq(schema.chatGroups.id, g.id));
      } else if (g.ownerKey === args.playerKey) {
        const next = [...rest].sort((a, b) => a.id - b.id)[0];
        if (next) await db.update(schema.chatGroups).set({ ownerKey: next.playerKey }).where(eq(schema.chatGroups.id, g.id));
      }
      ctx.invalidateQueries();
      return { left: true };
    },
  }),

  removeGroupMember: defineAction({
    description: "Removes a member from a player-made group chat. Only the group's owner can do this. Crew chat membership is automatic from the crew list, so it is not removable here.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      groupId: z.number().int().positive(),
      memberKey: z.string().min(1).max(80),
    }),
    response: z.object({ removed: z.literal(true) }),
    async handler(ctx, args): Promise<{ removed: true }> {
      const db = ctx.db<typeof schema>();
      const groups = await db.select().from(schema.chatGroups).where(eq(schema.chatGroups.id, args.groupId));
      const g = groups[0];
      if (!g) throw new Error("That chat no longer exists.");
      if (g.kind === "crew") throw new Error("Crew chat membership follows the crew — it can't be removed here.");
      if (g.ownerKey !== args.playerKey) throw new Error("Only the group owner can remove members.");
      if (args.memberKey === args.playerKey) throw new Error("Use Leave group to remove yourself.");
      const rows = await db.select().from(schema.chatGroupMembers)
        .where(and(eq(schema.chatGroupMembers.groupId, g.id), eq(schema.chatGroupMembers.playerKey, args.memberKey)));
      const row = rows[0];
      if (!row) throw new Error("That player isn't in this group.");
      await db.delete(schema.chatGroupMembers).where(eq(schema.chatGroupMembers.id, row.id));
      ctx.invalidateQueries();
      return { removed: true };
    },
  }),

  setGroupMemberMuted: defineAction({
    description: "Mutes or unmutes one member of a group, crew or event chat — only the chat's leader/owner can do this (the event host for event chats, the crew Leader for crew chats). A muted member can read but cannot send until unmuted.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      groupId: z.number().int().positive(),
      memberKey: z.string().min(1).max(80),
      muted: z.boolean(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const groups = await db.select().from(schema.chatGroups).where(eq(schema.chatGroups.id, args.groupId));
      const g = groups[0];
      if (!g) throw new Error("Chat not found.");
      if (g.ownerKey !== args.playerKey) throw new Error("Only this chat's leader can mute or unmute members.");
      if (args.memberKey === args.playerKey) throw new Error("You can't mute yourself.");
      const rows = await db
        .select()
        .from(schema.chatGroupMembers)
        .where(and(eq(schema.chatGroupMembers.groupId, args.groupId), eq(schema.chatGroupMembers.playerKey, args.memberKey)));
      const row = rows[0];
      if (!row) throw new Error("That player is not a member of this chat.");
      await db.update(schema.chatGroupMembers).set({ muted: args.muted ? 1 : 0 }).where(eq(schema.chatGroupMembers.id, row.id));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  listFollowedPeople: defineAction({
    description: "Lists everyone the player follows, NEWEST follow first — the Messages page's Following box and the group-chat picker's people list. Blocked players are excluded.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
    }),
    response: z.object({
      items: z.array(z.object({
        playerKey: z.string(), gamertag: z.string(), displayName: z.string(), avatarUrl: z.string(), avatarEffect: z.string(),
        presence: z.string(), followedAt: z.string(), relation: z.string(),
      })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profs = await db.select().from(schema.profiles);
      const byKey = new Map(profs.map((p) => [p.playerKey, p]));
      if (!byKey.get(args.playerKey)) return { items: [] };
      const art = await avatarArtUrls(ctx);
      const customArt = await customAvatarUrls(ctx);
      const blockedSet = await blockedKeysFor(ctx, args.playerKey);
      const follows = (await db.select().from(schema.profileFollows))
        .filter((f) => f.followerKey === args.playerKey)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
      const memberRows = await db.select().from(schema.clanMembers);
      const myClans = new Set(memberRows.filter((m) => m.playerKey === args.playerKey).map((m) => m.clanId));
      const crewmates = new Set(memberRows.filter((m) => myClans.has(m.clanId)).map((m) => m.playerKey));
      return {
        items: follows
          .map((f) => byKey.get(f.followingKey))
          .filter((p): p is NonNullable<typeof p> => Boolean(p) && !blockedSet.has(p!.playerKey))
          .map((p) => {
            const f = follows.find((x) => x.followingKey === p.playerKey);
            return {
              playerKey: p.playerKey, gamertag: p.gamertag, displayName: p.displayName,
              avatarUrl: pickAvatar(art, customArt, p), avatarEffect: p.avatarEffect,
              presence: effectivePresence(p, args.playerKey),
              followedAt: f?.createdAt.toISOString() ?? "",
              relation: crewmates.has(p.playerKey) ? "Crewmate" : "",
            };
          }),
      };
    },
  }),

  listDmPeople: defineAction({
    description: "Lists people the player can start a new direct-message conversation with: every other ViceSunshine profile, people they follow and crewmates first, with search. Used by the Messages page's new-message picker and its blue Send message button.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      search: z.string().trim().max(80).default(""),
    }),
    response: z.object({
      items: z.array(z.object({
        playerKey: z.string(), gamertag: z.string(), displayName: z.string(), avatarUrl: z.string(), avatarEffect: z.string(),
        presence: z.string(), relation: z.string(),
      })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profs = await db.select().from(schema.profiles);
      const byKey = new Map(profs.map((p) => [p.playerKey, p]));
      if (!byKey.get(args.playerKey)) return { items: [] };
      const art = await avatarArtUrls(ctx);
      const customArt = await customAvatarUrls(ctx);
      const follows = await db.select().from(schema.profileFollows);
      const iFollow = new Set(follows.filter((f) => f.followerKey === args.playerKey).map((f) => f.followingKey));
      // Second-degree: people followed by people I follow — the
      // X-style "Followed by people you follow" suggestion reason,
      // computed from real follow rows only.
      const followedByMine = new Set(follows.filter((f) => iFollow.has(f.followerKey)).map((f) => f.followingKey));
      const myCrews = await db.select().from(schema.clanMembers).where(eq(schema.clanMembers.playerKey, args.playerKey));
      const crewIds = new Set(myCrews.map((m) => m.clanId));
      const allMembers = crewIds.size ? await db.select().from(schema.clanMembers) : [];
      const crewmateKeys = new Set(allMembers.filter((m) => crewIds.has(m.clanId)).map((m) => m.playerKey));
      const blockedSet = await blockedKeysFor(ctx, args.playerKey);
      const q = args.search.trim().toLowerCase();
      const items = profs
        .filter((p) => p.playerKey !== args.playerKey && !blockedSet.has(p.playerKey))
        .filter((p) => !q || p.gamertag.toLowerCase().includes(q) || p.displayName.toLowerCase().includes(q))
        .map((p) => ({
          playerKey: p.playerKey, gamertag: p.gamertag, displayName: p.displayName,
          avatarUrl: pickAvatar(art, customArt, p), avatarEffect: p.avatarEffect,
          presence: effectivePresence(p, args.playerKey),
          relation: crewmateKeys.has(p.playerKey) ? "Crewmate" : iFollow.has(p.playerKey) ? "Following" : followedByMine.has(p.playerKey) ? "Followed by people you follow" : "",
          _rank: crewmateKeys.has(p.playerKey) ? 0 : iFollow.has(p.playerKey) ? 1 : followedByMine.has(p.playerKey) ? 2 : 3,
        }))
        .sort((a, b) => a._rank - b._rank || a.gamertag.localeCompare(b.gamertag))
        .slice(0, 40)
        .map(({ _rank, ...rest }) => rest);
      return { items };
    },
  }),

  getFeedPostsByIds: defineAction({
    description: "Returns specific Feed posts by id for the profile's Saved tab (the ids come from the player's own on-device Saved list). Flagged, hidden and blocked posts are skipped, exactly like the Feed.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      ids: z.array(z.number().int().positive()).max(100).default([]),
    }),
    response: z.object({ items: z.array(profilePostItem) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (args.ids.length === 0) return { items: [] };
      const all = await db.select().from(schema.feedPosts);
      const byId = new Map(all.map((r) => [r.id, r]));
      const hidden = await db.select().from(schema.feedHidden).where(eq(schema.feedHidden.playerKey, args.playerKey));
      const hiddenSet = new Set(hidden.map((h) => h.postId));
      const blockedSet = await blockedKeysFor(ctx, args.playerKey);
      const rows = args.ids
        .map((id) => byId.get(id))
        .filter((r): r is (typeof all)[number] => Boolean(r))
        .filter((r) => !hiddenSet.has(r.id) && !blockedSet.has(r.authorKey) && (r.flagged !== 1 || r.authorKey === args.playerKey));
      return { items: await profilePostItems(ctx, rows, args.playerKey) };
    },
  }),

  getMyClan: defineAction({
    description: "Returns the crew the player belongs to (id and name), or zeroes when they are in no crew — a player can only be in one crew at a time.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({ clanId: z.number(), clanName: z.string(), role: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.clanMembers).where(eq(schema.clanMembers.playerKey, args.playerKey));
      const mine = rows[0];
      if (!mine) return { clanId: 0, clanName: "", role: "" };
      const clans = await db.select().from(schema.clans);
      const clan = clans.find((c) => c.id === mine.clanId);
      return { clanId: mine.clanId, clanName: clan?.name ?? "", role: mine.role };
    },
  }),

  listClans: defineAction({
    description: "Lists crews for discovery with platform/playstyle/search filters.",
    request: z.object({
      platform: z.string().max(10).default("All"),
      playstyle: z.string().max(30).default("All"),
      search: z.string().max(80).default(""),
    }),
    response: z.object({ items: z.array(clanSummary) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let rows = await db.select().from(schema.clans).orderBy(desc(schema.clans.factionPoints));
      const members = await db.select().from(schema.clanMembers);
      const counts = new Map<number, number>();
      for (const m of members) counts.set(m.clanId, (counts.get(m.clanId) ?? 0) + 1);
      if (args.platform !== "All") rows = rows.filter((r) => r.platform === args.platform || r.platform === "Both");
      if (args.playstyle !== "All") rows = rows.filter((r) => r.playstyle === args.playstyle);
      const q = args.search.trim().toLowerCase();
      if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.tag.toLowerCase().includes(q));
      const stats = await computeClanRankStats(ctx, seasonKeyOf(new Date()));
      const ranks = seasonRankMap(stats);
      const items = rows.map((r) =>
        clanSummaryOf(r, counts.get(r.id) ?? 0, stats.get(r.id) ?? EMPTY_RANK, {
          warsWon: 0,
          seasonRank: ranks.get(r.id) ?? 0,
        }),
      );
      items.sort((a, b) => b.trophies - a.trophies || b.factionPoints - a.factionPoints);
      return { items };
    },
  }),

  clanRankings: defineAction({
    description:
      "Returns the seasonal crew leaderboards for the Crew Leaderboard page: global, local (crews in the viewer's region), PlayStation and Xbox — ranked by this month's confirmed seasonal Rank Points (effective, after the member-level multiplier). Seasonal points reset every month; lifetime Crew Level does not.",
    request: z.object({
      region: z.string().trim().max(60).default(""),
    }),
    response: z.object({
      region: z.string(),
      seasonKey: z.string(),
      seasonLabel: z.string(),
      seasonEndsAt: z.string(),
      global: z.array(clanSummary.extend({ rank: z.number(), trend: z.string(), prevRank: z.number() })),
      local: z.array(clanSummary.extend({ rank: z.number(), trend: z.string(), prevRank: z.number() })),
      playstation: z.array(clanSummary.extend({ rank: z.number(), trend: z.string(), prevRank: z.number() })),
      xbox: z.array(clanSummary.extend({ rank: z.number(), trend: z.string(), prevRank: z.number() })),
      // Season progress graph per board: cumulative effective
      // season points for the board's top 5 crews at each weekly
      // checkpoint of the current season month (real rank-point
      // events only, multiplied by each crew's member-level
      // multiplier — the same effective points the board ranks by).
      graphs: z.object({
        global: clanBoardGraph,
        local: clanBoardGraph,
        playstation: clanBoardGraph,
        xbox: clanBoardGraph,
      }),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.clans);
      const members = await db.select().from(schema.clanMembers);
      const counts = new Map<number, number>();
      for (const m of members) counts.set(m.clanId, (counts.get(m.clanId) ?? 0) + 1);
      const seasonKey = seasonKeyOf(new Date());
      const stats = await computeClanRankStats(ctx, seasonKey);
      const ranks = seasonRankMap(stats);
      const all = rows.map((r) =>
        clanSummaryOf(r, counts.get(r.id) ?? 0, stats.get(r.id) ?? EMPTY_RANK, {
          warsWon: 0,
          seasonRank: ranks.get(r.id) ?? 0,
        }),
      );
      all.sort(
        (a, b) =>
          b.effectiveSeasonPoints - a.effectiveSeasonPoints ||
          b.effectiveLifetimePoints - a.effectiveLifetimePoints ||
          b.trophies - a.trophies ||
          a.name.localeCompare(b.name),
      );
      // Trend vs last season's final standings (recorded by
      // closeSeason). No recorded finish = "new" — never invented.
      const prevWinners = await db
        .select()
        .from(schema.seasonWinners)
        .where(eq(schema.seasonWinners.seasonKey, previousSeasonKeyOf(seasonKey)));
      const prevByBoard = new Map<string, Map<number, number>>();
      for (const w of prevWinners) {
        if (!prevByBoard.has(w.board)) prevByBoard.set(w.board, new Map());
        prevByBoard.get(w.board)?.set(w.clanId, w.rank);
      }
      const ranked = (list: typeof all, board: string) =>
        list.map((c, i) => {
          const rank = i + 1;
          const prevRank = prevByBoard.get(board)?.get(c.id) ?? prevByBoard.get("Global")?.get(c.id) ?? 0;
          const trend = prevRank === 0 ? "new" : rank < prevRank ? "up" : rank > prevRank ? "down" : "same";
          return { ...c, rank, trend, prevRank };
        });
      const region = args.region.trim().toLowerCase();
      const sameRegion = (clanRegion: string) => {
        if (!region) return false;
        const cr = clanRegion.trim().toLowerCase();
        return cr !== "" && (cr === region || cr.includes(region) || region.includes(cr));
      };
      const globalBoard = ranked(all, "Global");
      const localBoard = ranked(all.filter((c) => sameRegion(c.region)), "Global");
      const psBoard = ranked(all.filter((c) => c.platform === "PS5" || c.platform === "Both"), "PlayStation");
      const xboxBoard = ranked(all.filter((c) => c.platform === "Xbox" || c.platform === "Both"), "Xbox");
      // Weekly checkpoints for the season graph: the 7th, 14th,
      // 21st and 28th of the season month, plus today as the final
      // live point (checkpoints in the future are not plotted).
      const seasonEvents = await db
        .select()
        .from(schema.rankPointEvents)
        .where(eq(schema.rankPointEvents.seasonKey, seasonKey));
      const [sy = 1970, sm = 1] = seasonKey.split("-").map(Number);
      const seasonStartMs = Date.UTC(sy, sm - 1, 1);
      const nowMs = Date.now();
      const checkpointEnds: number[] = [];
      for (const dnum of [7, 14, 21, 28]) {
        const end = seasonStartMs + dnum * 24 * 60 * 60 * 1000;
        if (end <= nowMs) checkpointEnds.push(end);
      }
      checkpointEnds.push(nowMs);
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const checkpointLabels = checkpointEnds.map((end, i) =>
        i === checkpointEnds.length - 1
          ? "Today"
          : `${monthNames[new Date(end - 1).getUTCMonth()]} ${new Date(end - 1).getUTCDate()}`,
      );
      const buildGraph = (board: typeof globalBoard) => ({
        labels: checkpointLabels,
        crews: board.slice(0, 5).map((c) => {
          const mult = stats.get(c.id)?.multiplier ?? 1;
          const mine = seasonEvents
            .filter((e) => e.clanId === c.id)
            .map((e) => ({ ts: e.createdAt ? e.createdAt.getTime() : 0, points: e.points }))
            .sort((a, b) => a.ts - b.ts);
          let acc = 0;
          let ptr = 0;
          const values = checkpointEnds.map((end) => {
            while (ptr < mine.length && (mine[ptr]?.ts ?? Infinity) < end) {
              acc += mine[ptr]?.points ?? 0;
              ptr++;
            }
            return Math.round(acc * mult);
          });
          return { id: c.id, name: c.name, color: c.color, values };
        }),
      });
      return {
        region: args.region.trim(),
        seasonKey,
        seasonLabel: seasonLabelOf(seasonKey),
        seasonEndsAt: seasonEndsAtOf(seasonKey),
        global: globalBoard,
        local: localBoard,
        playstation: psBoard,
        xbox: xboxBoard,
        graphs: {
          global: buildGraph(globalBoard),
          local: buildGraph(localBoard),
          playstation: buildGraph(psBoard),
          xbox: buildGraph(xboxBoard),
        },
      };
    },
  }),

  createClan: defineAction({
    description: "Creates a crew and makes the creator its Leader. Costs 500 Vice Credits from the creator's personal wallet (a new account starts with exactly 500).",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().min(2).max(32),
      platform: platformEnum.default("PS5"),
      name: z.string().trim().min(3).max(48),
      tag: z.string().trim().min(2).max(4),
      color: z.string().trim().max(9).default("#FF2E88"),
      // "phoenix" is deliberately NOT a starting emblem: it is a Clan
      // Award, earned only by finishing a season ranked #1.
      emblem: z.enum(["shield", "crown", "star", "bolt", "palm", "flame", "gem", "wave", "sunset", "serpent", "diamond", "vicecrest"]).default("shield"),
      motto: z.string().trim().max(120).default(""),
      description: z.string().trim().max(1500).default(""),
      clanPlatform: platformEnum.default("Both"),
      region: z.string().trim().max(40).default(""),
      language: z.string().trim().max(30).default("English"),
      playstyle: z.string().trim().max(30).default("Chill"),
      privacy: z.enum(["Public", "Invite-Only", "Application"]).default("Public"),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      assertClean(args.name, args.tag, args.motto, args.description);
      const all = await db.select().from(schema.clans);
      const tag = args.tag.toUpperCase();
      if (all.some((c) => c.name.toLowerCase() === args.name.toLowerCase())) {
        throw new Error("A crew with that name already exists. Pick a unique name.");
      }
      if (all.some((c) => c.tag.toUpperCase() === tag)) {
        throw new Error("That 4-letter tag is taken. Try another tag.");
      }
      // Premium is read from the creator's own account, never from
      // the request: a Premium founder's clan holds 200 members, a
      // free founder's holds 50, and the Vice Crest emblem is
      // Premium-only.
      const creatorPremium = await premiumActiveFor(ctx, args.playerKey);
      if (args.emblem === "vicecrest" && !creatorPremium) {
        throw new Error("The Vice Crest emblem is included with Premium — a Premium member needs to found or lead this crew to use it.");
      }
      // Creating a clan costs 500 Vice Credits — exactly the starting
      // balance every new account receives, so a new player can found
      // one clan free, and must earn more before founding a second.
      const profRows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const prof = profRows[0];
      if (!prof) {
        throw new Error(
          "Create your profile first — a new account starts with 500 Vice Credits, and creating a crew costs 500.",
        );
      }
      await assertNotInAnotherCrew(ctx, args.playerKey);
      if (prof.credits < CLAN_CREATE_COST) {
        throw new Error(
          `Creating a crew costs ${CLAN_CREATE_COST} Vice Credits, but you have ${prof.credits}. Earn more from in-app activity, community events and seasonal awards — see How to earn points in Crews.`,
        );
      }
      await db
        .update(schema.profiles)
        .set({ credits: prof.credits - CLAN_CREATE_COST })
        .where(eq(schema.profiles.id, prof.id));
      await logCredit(
        ctx,
        "personal",
        args.playerKey,
        args.playerKey,
        -CLAN_CREATE_COST,
        `Created crew ${args.name}`,
      );
      const res = await db
        .insert(schema.clans)
        .values({
          name: args.name,
          tag,
          color: args.color,
          emblem: args.emblem,
          motto: args.motto,
          description: args.description,
          platform: args.clanPlatform,
          region: args.region,
          language: args.language,
          playstyle: args.playstyle,
          privacy: args.privacy,
          maxMembers: creatorPremium ? 200 : 50,
        })
        .returning({ id: schema.clans.id });
      const clanId = res[0]?.id ?? 0;
      await db.insert(schema.clanMembers).values({
        clanId,
        playerKey: args.playerKey,
        gamertag: args.gamertag,
        platform: args.platform,
        role: "Leader",
      });
      await logActivity(ctx, clanId, args.gamertag, "founded the crew", "", "");
      ctx.invalidateQueries();
      return { id: clanId };
    },
  }),

  getClan: defineAction({
    description: "Returns one crew's full home: members, squads, posts, applications, activity log.",
    request: z.object({
      clanId: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
    }),
    response: z.object({
      clan: clanSummary,
      myRole: z.string(),
      members: z.array(memberItem),
      squads: z.array(
        z.object({ id: z.number(), name: z.string(), leadGamertag: z.string(), focus: z.string(), memberCount: z.number() }),
      ),
      announcements: z.array(z.object({ id: z.number(), author: z.string(), body: z.string(), createdAt: z.string() })),
      feed: z.array(z.object({ id: z.number(), author: z.string(), body: z.string(), createdAt: z.string() })),
      chat: z.array(z.object({ id: z.number(), author: z.string(), body: z.string(), createdAt: z.string() })),
      channels: z.array(
        z.object({
          id: z.number(),
          kind: z.string(),
          key: z.string(),
          name: z.string(),
          visibility: z.string(),
          memberLimit: z.number(),
          allowedRoles: z.array(z.string()),
          allowedKeys: z.array(z.string()),
          sortOrder: z.number(),
        }),
      ),
      channelPosts: z.array(
        z.object({
          channelKey: z.string(),
          posts: z.array(z.object({ id: z.number(), author: z.string(), body: z.string(), createdAt: z.string() })),
        }),
      ),
      canManageChannels: z.boolean(),
      eldersManageChannels: z.boolean(),
      awards: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          requirement: z.string(),
          itemId: z.string(),
          rewardName: z.string(),
          earned: z.boolean(),
          equipped: z.boolean(),
        }),
      ),
      applications: z.array(
        z.object({ id: z.number(), gamertag: z.string(), message: z.string(), createdAt: z.string() }),
      ),
      activity: z.array(
        z.object({ id: z.number(), actor: z.string(), action: z.string(), target: z.string(), reason: z.string(), createdAt: z.string() }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const clanRows = await db.select().from(schema.clans).where(eq(schema.clans.id, args.clanId));
      const clan = clanRows[0];
      if (!clan) throw new Error("Crew not found.");
      const members = await db
        .select()
        .from(schema.clanMembers)
        .where(eq(schema.clanMembers.clanId, args.clanId));
      const me = members.find((m) => m.playerKey === args.playerKey);
      const myRole = me?.role ?? "";
      const canModerate = myRole === "Leader" || myRole === "Co-Leader";
      const squadRows = await db.select().from(schema.squads).where(eq(schema.squads.clanId, args.clanId));
      const posts = await db
        .select()
        .from(schema.clanPosts)
        .where(eq(schema.clanPosts.clanId, args.clanId))
        .orderBy(desc(schema.clanPosts.id));
      const apps = canModerate
        ? await db
            .select()
            .from(schema.clanApplications)
            .where(
              and(
                eq(schema.clanApplications.clanId, args.clanId),
                eq(schema.clanApplications.status, "Pending"),
              ),
            )
        : [];
      const activity = await db
        .select()
        .from(schema.clanActivity)
        .where(eq(schema.clanActivity.clanId, args.clanId))
        .orderBy(desc(schema.clanActivity.id))
        .limit(50);
      const toPost = (p: typeof posts[number]) => ({
        id: p.id,
        author: p.author,
        body: p.body,
        createdAt: p.createdAt.toISOString(),
      });
      const sortedMembers = [...members].sort(
        (a, b) => (ROLE_RANK[b.role] ?? 0) - (ROLE_RANK[a.role] ?? 0) || a.gamertag.localeCompare(b.gamertag),
      );
      const profileMap = await profilesByKey(ctx);
      const artUrls = await avatarArtUrls(ctx);
      const customArt = await customAvatarUrls(ctx);
      return {
        clan: clanSummaryOf(
          clan,
          members.length,
          await (async () => {
            const stats = await computeClanRankStats(ctx, seasonKeyOf(new Date()));
            return stats.get(clan.id) ?? EMPTY_RANK;
          })(),
          await (async () => {
            const stats = await computeClanRankStats(ctx, seasonKeyOf(new Date()));
                return {
              warsWon: 0,
              seasonRank: seasonRankMap(stats).get(clan.id) ?? 0,
            };
          })(),
        ),
        myRole,
        members: sortedMembers.map((m) => ({
          id: m.id,
          playerKey: m.playerKey,
          gamertag: m.gamertag,
          platform: m.platform,
          role: m.role,
          squad: m.squad,
          isMe: m.playerKey === args.playerKey,
          joinedAt: m.joinedAt.toISOString(),
          nameColor: "",
          avatarFrame: "",
          avatarUrl: pickAvatar(artUrls, customArt, profileMap.get(m.playerKey)),
          badge: profileMap.get(m.playerKey)?.badge ?? "",
          inVoice: false,
          presence: (() => {
            const mp = profileMap.get(m.playerKey);
            return mp ? effectivePresence(mp, args.playerKey) : "Offline";
          })(),
          // Crew roster: a private Rockstar ID is crew-visible, so
          // members of THIS clan (myRole set) see each other's IDs;
          // anyone just browsing the clan page gets public-only.
          links: visibleLinks(profileMap.get(m.playerKey), { sameCrew: myRole !== "" }),
        })),
        squads: squadRows.map((s) => ({
          id: s.id,
          name: s.name,
          leadGamertag: s.leadGamertag,
          focus: s.focus,
          memberCount: members.filter((m) => m.squad === s.name).length,
        })),
        announcements: posts.filter((p) => p.channel === "announcement").map(toPost),
        feed: posts.filter((p) => p.channel === "feed").map(toPost),
        chat: posts.filter((p) => p.channel === "chat").slice(0, 60).reverse().map(toPost),
        channels: await (async () => {
          const all = await clanChannelsOf(ctx, args.clanId);
          // Managers see every channel (they structure them); everyone
          // else only sees channels they are allowed into — private
          // channels stay invisible to members not on the allow-list.
          const visible = canModerate || (clan ? canManageChannels(myRole, clan) : false)
            ? all
            : all.filter((ch) => channelVisibleTo(ch, myRole, args.playerKey));
          return visible.map((ch) => ({
            id: ch.id,
            kind: ch.kind,
            key: ch.key,
            name: ch.name,
            visibility: ch.visibility,
            memberLimit: ch.memberLimit,
            allowedRoles: ch.allowedRoles.split(",").map((s) => s.trim()).filter(Boolean),
            allowedKeys: ch.allowedKeys.split(",").map((s) => s.trim()).filter(Boolean),
            sortOrder: ch.sortOrder,
          }));
        })(),
        channelPosts: await (async () => {
          const all = await clanChannelsOf(ctx, args.clanId);
          const visibleText = all.filter(
            (ch) =>
              ch.kind === "text" &&
              (canModerate || (clan ? canManageChannels(myRole, clan) : false) || channelVisibleTo(ch, myRole, args.playerKey)),
          );
          return visibleText.map((ch) => ({
            channelKey: ch.key,
            posts: posts.filter((p) => p.channel === ch.key).slice(0, 60).reverse().map(toPost),
          }));
        })(),
        canManageChannels: clan ? canManageChannels(myRole, clan) : false,
        eldersManageChannels: clan.eldersManageChannels === 1,
        awards: await (async () => {
          // Clan Awards — earned, never for sale: grant anything newly
          // earned, then report every award with its earned state.
          await applyClanAwards(ctx, clan.id, members.length);
          const ownedRows = await db.select().from(schema.ownedItems);
          return CLAN_AWARDS.map((a) => {
            const def = awardItem(a.itemId);
            const earned = ownedRows.some(
              (o) => o.ownerType === "clan" && o.ownerId === String(clan.id) && o.itemId === a.itemId,
            );
            const equipped = !def
              ? false
              : def.kind === "emblem"
                ? clan.emblem === def.value
                : def.kind === "banner"
                  ? clan.bannerStyle === def.value
                  : false;
            return {
              id: a.id,
              name: a.name,
              requirement: a.requirement,
              itemId: a.itemId,
              rewardName: def?.name ?? a.itemId,
              earned,
              equipped,
            };
          });
        })(),
        applications: apps.map((a) => ({
          id: a.id,
          gamertag: a.gamertag,
          message: a.message,
          createdAt: a.createdAt.toISOString(),
        })),
        activity: activity.map((a) => ({
          id: a.id,
          actor: a.actor,
          action: a.action,
          target: a.target,
          reason: a.reason,
          createdAt: a.createdAt.toISOString(),
        })),
      };
    },
  }),

  joinClan: defineAction({
    description: "Joins a public crew directly as a Recruit, or files an application for application/invite crews.",
    request: z.object({
      clanId: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().min(2).max(32),
      platform: platformEnum.default("PS5"),
      message: z.string().trim().max(500).default(""),
    }),
    response: z.object({ joined: z.boolean(), applied: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const clanRows = await db.select().from(schema.clans).where(eq(schema.clans.id, args.clanId));
      const clan = clanRows[0];
      if (!clan) throw new Error("Crew not found.");
      const existing = await myMembership(ctx, args.clanId, args.playerKey);
      if (existing) throw new Error("You are already a member of this crew.");
      await assertNotInAnotherCrew(ctx, args.playerKey, args.clanId);
      const members = await db
        .select()
        .from(schema.clanMembers)
        .where(eq(schema.clanMembers.clanId, args.clanId));
      const cap = await effectiveClanCap(ctx, clan);
      if (members.length >= cap) {
        throw new Error(`This crew is full (${cap} members). A crew led by a Premium member can hold up to 200.`);
      }
      if (clan.privacy === "Public") {
        await db.insert(schema.clanMembers).values({
          clanId: args.clanId,
          playerKey: args.playerKey,
          gamertag: args.gamertag,
          platform: args.platform,
          role: "Recruit",
        });
        await logActivity(ctx, args.clanId, args.gamertag, "joined as Recruit", "", "");
        await awardRecruit(ctx, args.clanId, clan.name, args.playerKey, args.gamertag);
        ctx.invalidateQueries();
        return { joined: true, applied: false };
      }
      await db.insert(schema.clanApplications).values({
        clanId: args.clanId,
        playerKey: args.playerKey,
        gamertag: args.gamertag,
        message: args.message,
      });
      ctx.invalidateQueries();
      return { joined: false, applied: true };
    },
  }),

  reviewApplication: defineAction({
    description: "Approves or declines a pending crew application (Leader/Co-Leader).",
    request: z.object({
      clanId: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
      applicationId: z.number().int().positive(),
      approve: z.boolean(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const me = await myMembership(ctx, args.clanId, args.playerKey);
      if (!me || (me.role !== "Leader" && me.role !== "Co-Leader")) {
        throw new Error("Only the Leader or a Co-Leader can review applications.");
      }
      const apps = await db
        .select()
        .from(schema.clanApplications)
        .where(eq(schema.clanApplications.id, args.applicationId));
      const app = apps[0];
      if (!app || app.clanId !== args.clanId || app.status !== "Pending") {
        throw new Error("Application not found or already reviewed.");
      }
      await db
        .update(schema.clanApplications)
        .set({ status: args.approve ? "Approved" : "Declined" })
        .where(eq(schema.clanApplications.id, args.applicationId));
      if (args.approve) {
        const clanRowsCap = await db.select().from(schema.clans).where(eq(schema.clans.id, args.clanId));
        const clanCapRow = clanRowsCap[0];
        if (clanCapRow) {
          const cap = await effectiveClanCap(ctx, clanCapRow);
          const current = await db
            .select()
            .from(schema.clanMembers)
            .where(eq(schema.clanMembers.clanId, args.clanId));
          if (current.length >= cap) {
            throw new Error(`This crew is full (${cap} members), so this application cannot be approved right now. A crew led by a Premium member can hold up to 200.`);
          }
        }
        const prof = await db
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.playerKey, app.playerKey));
        await assertNotInAnotherCrew(ctx, app.playerKey, args.clanId, app.gamertag);
        await db.insert(schema.clanMembers).values({
          clanId: args.clanId,
          playerKey: app.playerKey,
          gamertag: app.gamertag,
          platform: prof[0]?.platform ?? "PS5",
          role: "Recruit",
        });
        await logActivity(ctx, args.clanId, me.gamertag, "approved application from", app.gamertag, "");
        const clanRows2 = await db.select().from(schema.clans).where(eq(schema.clans.id, args.clanId));
        await awardRecruit(ctx, args.clanId, clanRows2[0]?.name ?? "clan", app.playerKey, app.gamertag);
      } else {
        await logActivity(ctx, args.clanId, me.gamertag, "declined application from", app.gamertag, "");
      }
      ctx.invalidateQueries();
      return ok();
    },
  }),

  changeRole: defineAction({
    description:
      "Promotes, demotes, or kicks a crew member, enforcing the Leader > Co-Leader > Elder > Member > Recruit hierarchy, and logs it.",
    request: z.object({
      clanId: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
      memberId: z.number().int().positive(),
      action: z.enum(["promote", "demote", "kick", "transfer"]),
      reason: z.string().trim().max(300).default(""),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const me = await myMembership(ctx, args.clanId, args.playerKey);
      if (!me) throw new Error("You are not a member of this crew.");
      const targets = await db
        .select()
        .from(schema.clanMembers)
        .where(eq(schema.clanMembers.id, args.memberId));
      const target = targets[0];
      if (!target || target.clanId !== args.clanId) throw new Error("Member not found.");
      if (target.id === me.id) throw new Error("You cannot change your own role this way.");
      const myRank = ROLE_RANK[me.role] ?? 0;
      const targetRank = ROLE_RANK[target.role] ?? 0;

      if (args.action === "transfer") {
        if (me.role !== "Leader") throw new Error("Only the Leader can transfer leadership.");
        if (target.role !== "Co-Leader") {
          throw new Error("Leadership can only be transferred to a Co-Leader.");
        }
        await db.update(schema.clanMembers).set({ role: "Leader" }).where(eq(schema.clanMembers.id, target.id));
        await db.update(schema.clanMembers).set({ role: "Co-Leader" }).where(eq(schema.clanMembers.id, me.id));
        await logActivity(ctx, args.clanId, me.gamertag, "transferred leadership to", target.gamertag, args.reason);
        ctx.invalidateQueries();
        return ok();
      }

      if (myRank <= targetRank) {
        throw new Error("You cannot promote, demote, or kick someone at your level or above you.");
      }

      if (args.action === "kick") {
        if (me.role === "Member" || me.role === "Recruit") {
          throw new Error("Members and Recruits cannot kick anyone.");
        }
        if (me.role === "Elder" && target.role !== "Member" && target.role !== "Recruit") {
          throw new Error("Elders can only kick Members and Recruits.");
        }
        await db.delete(schema.clanMembers).where(eq(schema.clanMembers.id, target.id));
        await logActivity(ctx, args.clanId, me.gamertag, "kicked", target.gamertag, args.reason);
        ctx.invalidateQueries();
        return ok();
      }

      const order = ["Recruit", "Member", "Elder", "Co-Leader", "Leader"];
      const idx = order.indexOf(target.role);
      const nextIdx = args.action === "promote" ? idx + 1 : idx - 1;
      if (nextIdx < 0 || nextIdx >= order.length) {
        throw new Error(args.action === "promote" ? "Already at the top role." : "Already at the lowest role.");
      }
      const nextRole = order[nextIdx] ?? target.role;
      if (me.role === "Co-Leader" && !(target.role === "Member" && nextRole === "Elder" && args.action === "promote")) {
        throw new Error("Co-Leaders can only promote a Member to Elder. Other changes need the Leader.");
      }
      if (me.role === "Elder" || me.role === "Member" || me.role === "Recruit") {
        throw new Error("Your role cannot promote or demote members.");
      }
      await db
        .update(schema.clanMembers)
        .set({ role: nextRole as typeof target.role })
        .where(eq(schema.clanMembers.id, target.id));
      await logActivity(
        ctx,
        args.clanId,
        me.gamertag,
        args.action === "promote" ? `promoted to ${nextRole}:` : `demoted to ${nextRole}:`,
        target.gamertag,
        args.reason,
      );
      ctx.invalidateQueries();
      return ok();
    },
  }),

  leaveClan: defineAction({
    description: "Leaves a crew voluntarily. A Leader leaving with members left passes leadership to the highest-ranked, longest-standing member; a Leader who is the only member dissolves the crew (and its automatic crew chat). Leaving the crew also leaves its crew chat automatically.",
    request: z.object({
      clanId: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
    }),
    response: z.object({ ok: z.literal(true), dissolved: z.boolean(), newLeader: z.string() }),
    async handler(ctx, args): Promise<{ ok: true; dissolved: boolean; newLeader: string }> {
      const db = ctx.db<typeof schema>();
      const me = await myMembership(ctx, args.clanId, args.playerKey);
      if (!me) throw new Error("You are not a member of this crew.");
      const members = await db.select().from(schema.clanMembers).where(eq(schema.clanMembers.clanId, args.clanId));
      if (me.role !== "Leader") {
        await db.delete(schema.clanMembers).where(eq(schema.clanMembers.id, me.id));
        await logActivity(ctx, args.clanId, me.gamertag, "left the crew", "", "");
        ctx.invalidateQueries();
        return { ok: true, dissolved: false, newLeader: "" };
      }
      const others = members.filter((m) => m.id !== me.id);
      if (others.length === 0) {
        // Sole member is the Leader: the crew is dissolved, and
        // its automatic crew chat goes with it.
        const groups = await db.select().from(schema.chatGroups).where(and(eq(schema.chatGroups.kind, "crew"), eq(schema.chatGroups.clanId, args.clanId)));
        for (const g of groups) {
          await db.delete(schema.directMessages).where(eq(schema.directMessages.groupId, g.id));
          await db.delete(schema.chatGroupMembers).where(eq(schema.chatGroupMembers.groupId, g.id));
          await db.delete(schema.chatGroups).where(eq(schema.chatGroups.id, g.id));
        }
        await db.delete(schema.clanMembers).where(eq(schema.clanMembers.clanId, args.clanId));
        await db.delete(schema.clanApplications).where(eq(schema.clanApplications.clanId, args.clanId));
        await db.delete(schema.clanPosts).where(eq(schema.clanPosts.clanId, args.clanId));
        await db.delete(schema.clanChannels).where(eq(schema.clanChannels.clanId, args.clanId));
        await db.delete(schema.clanActivity).where(eq(schema.clanActivity.clanId, args.clanId));
        await db.delete(schema.squads).where(eq(schema.squads.clanId, args.clanId));
        await db.delete(schema.clans).where(eq(schema.clans.id, args.clanId));
        ctx.invalidateQueries();
        return { ok: true, dissolved: true, newLeader: "" };
      }
      // Leadership passes to the highest-ranked, longest-standing
      // remaining member, then the old Leader leaves.
      const rankOf = (r: string) => ROLE_RANK[r] ?? 0;
      const successor = [...others].sort((a, b) => rankOf(b.role) - rankOf(a.role) || a.id - b.id)[0];
      if (!successor) throw new Error("Could not pass leadership on — try again.");
      await db.update(schema.clanMembers).set({ role: "Leader" }).where(eq(schema.clanMembers.id, successor.id));
      await db.delete(schema.clanMembers).where(eq(schema.clanMembers.id, me.id));
      await logActivity(ctx, args.clanId, me.gamertag, "left the crew — leadership passed to", successor.gamertag, "");
      ctx.invalidateQueries();
      return { ok: true, dissolved: false, newLeader: successor.gamertag };
    },
  }),

  updateClan: defineAction({
    description: "Edits a crew's details from its crew page (Leader only): name, tag, colour, motto, description, platform, region, language, playstyle and privacy. The crew's automatic crew chat follows — its name, picture, banner and settings are the crew's.",
    request: z.object({
      clanId: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
      name: z.string().trim().min(3).max(40),
      tag: z.string().trim().min(2).max(4),
      color: z.string().trim().min(4).max(9),
      motto: z.string().trim().max(80).default(""),
      description: z.string().trim().max(600).default(""),
      rules: z.string().trim().max(600).default(""),
      platform: z.enum(["PS5", "Xbox", "Both"]),
      region: z.string().trim().max(40).default(""),
      language: z.string().trim().min(2).max(30),
      playstyle: z.string().trim().min(2).max(30),
      privacy: z.enum(["Public", "Invite-Only", "Application"]),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const me = await myMembership(ctx, args.clanId, args.playerKey);
      if (!me) throw new Error("You are not a member of this crew.");
      if (me.role !== "Leader") throw new Error("Only the crew Leader can edit the crew's details.");
      const all = await db.select().from(schema.clans);
      const clan = all.find((c) => c.id === args.clanId);
      if (!clan) throw new Error("Crew not found.");
      const tag = args.tag.toUpperCase();
      if (all.some((c) => c.id !== args.clanId && c.name.trim().toLowerCase() === args.name.trim().toLowerCase())) {
        throw new Error("A crew with that name already exists. Pick a unique name.");
      }
      if (all.some((c) => c.id !== args.clanId && c.tag.trim().toUpperCase() === tag)) {
        throw new Error("That tag is taken by another crew. Try another tag.");
      }
      await db.update(schema.clans).set({
        name: args.name,
        tag,
        color: args.color,
        motto: args.motto,
        description: args.description,
        rules: args.rules,
        platform: args.platform,
        region: args.region,
        language: args.language,
        playstyle: args.playstyle,
        privacy: args.privacy,
      }).where(eq(schema.clans.id, args.clanId));
      await logActivity(ctx, args.clanId, me.gamertag, "updated the crew details", "", "");
      ctx.invalidateQueries();
      return ok();
    },
  }),

  listCrewActivityFeed: defineAction({
    description: "Returns the latest activity across all crews (joins, promotions, posts, leadership changes) with each crew's identity, for the live Crews page ticker.",
    request: z.object({}),
    response: z.object({
      items: z.array(z.object({
        id: z.number(),
        clanId: z.number(),
        clanName: z.string(),
        clanTag: z.string(),
        clanColor: z.string(),
        clanEmblem: z.string(),
        text: z.string(),
        at: z.string(),
      })),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.clanActivity).orderBy(desc(schema.clanActivity.id)).limit(12);
      const clans = await db.select().from(schema.clans);
      const byId = new Map(clans.map((c) => [c.id, c]));
      const items = rows.flatMap((r) => {
        const clan = byId.get(r.clanId);
        if (!clan) return [];
        const text = [r.actor, r.action, r.target].filter((x) => x && x.trim()).join(" ");
        return [{
          id: r.id,
          clanId: r.clanId,
          clanName: clan.name,
          clanTag: clan.tag,
          clanColor: clan.color,
          clanEmblem: clan.emblem,
          text,
          at: r.createdAt ? new Date(r.createdAt).toISOString() : "",
        }];
      });
      return { items };
    },
  }),

  clanPost: defineAction({
    description: "Posts to one of the crew's text channels (announcements / crew feed / chat, plus any channels the Leader created) with role and private-channel checks.",
    request: z.object({
      clanId: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
      channel: z.string().min(1).max(40),
      body: z.string().trim().min(1).max(1000),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      assertClean(args.body);
      const me = await myMembership(ctx, args.clanId, args.playerKey);
      if (!me) throw new Error("Join this crew before posting.");
      const channels = await clanChannelsOf(ctx, args.clanId);
      const ch = channels.find((c) => c.kind === "text" && c.key === args.channel);
      if (!ch) throw new Error("That text channel does not exist in this crew.");
      if (!channelVisibleTo(ch, me.role, args.playerKey)) {
        throw new Error("That is a private channel — only members the Leader has allowed in can post there.");
      }
      if (args.channel === "announcement" && me.role !== "Leader" && me.role !== "Co-Leader") {
        throw new Error("Only the Leader and Co-Leaders can post announcements.");
      }
      const res = await db
        .insert(schema.clanPosts)
        .values({ clanId: args.clanId, channel: args.channel, author: me.gamertag, body: args.body })
        .returning({ id: schema.clanPosts.id });
      const postId = res[0]?.id ?? 0;
      if (args.channel !== "announcement") {
        await recordPoints(ctx, {
          playerKey: args.playerKey,
          gamertag: me.gamertag,
          targetClanId: args.clanId,
          points: 2,
          source: "clanpost",
          sourceRef: `clanpost:${postId}`,
          reason: "Posted in the crew feed",
          verifiedBy: "ViceSunshine (in-app post)",
        });
      }
      ctx.invalidateQueries();
      return { id: postId };
    },
  }),

  createSquad: defineAction({
    description: "Creates a squad/division inside a crew (Leader, Co-Leader, or Elder).",
    request: z.object({
      clanId: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
      name: z.string().trim().min(2).max(40),
      leadGamertag: z.string().trim().max(32).default(""),
      focus: z.string().trim().max(80).default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const me = await myMembership(ctx, args.clanId, args.playerKey);
      if (!me || (me.role !== "Leader" && me.role !== "Co-Leader" && me.role !== "Elder")) {
        throw new Error("Leaders, Co-Leaders and Elders can create squads.");
      }
      const res = await db
        .insert(schema.squads)
        .values({ clanId: args.clanId, name: args.name, leadGamertag: args.leadGamertag, focus: args.focus })
        .returning({ id: schema.squads.id });
      ctx.invalidateQueries();
      return { id: res[0]?.id ?? 0 };
    },
  }),

  setSquad: defineAction({
    description: "Assigns a crew member to a squad (or clears the assignment).",
    request: z.object({
      clanId: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
      memberId: z.number().int().positive(),
      squad: z.string().trim().max(40).default(""),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const me = await myMembership(ctx, args.clanId, args.playerKey);
      if (!me || (me.role !== "Leader" && me.role !== "Co-Leader" && me.role !== "Elder")) {
        throw new Error("Leaders, Co-Leaders and Elders manage squads.");
      }
      await db
        .update(schema.clanMembers)
        .set({ squad: args.squad })
        .where(eq(schema.clanMembers.id, args.memberId));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  joinFaction: defineAction({
    description: "Picks a seasonal faction (Green or Purple) for a crew in the community faction war.",
    request: z.object({
      clanId: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
      faction: z.enum(["Green", "Purple"]),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const me = await myMembership(ctx, args.clanId, args.playerKey);
      if (!me || (me.role !== "Leader" && me.role !== "Co-Leader")) {
        throw new Error("The Leader or a Co-Leader picks the crew's faction.");
      }
      await db.update(schema.clans).set({ faction: args.faction }).where(eq(schema.clans.id, args.clanId));
      await logActivity(ctx, args.clanId, me.gamertag, `joined the ${args.faction} faction`, "", "");
      ctx.invalidateQueries();
      return ok();
    },
  }),

  awardFactionPoints: defineAction({
    description: "Awards faction-war points to a crew after a community event result.",
    request: z.object({
      clanId: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
      points: z.number().int().min(1).max(100),
      reason: z.string().trim().max(200).default(""),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const me = await myMembership(ctx, args.clanId, args.playerKey);
      if (!me || (me.role !== "Leader" && me.role !== "Co-Leader")) {
        throw new Error("The Leader or a Co-Leader records faction points.");
      }
      const rows = await db.select().from(schema.clans).where(eq(schema.clans.id, args.clanId));
      const clan = rows[0];
      if (!clan) throw new Error("Crew not found.");
      if (!clan.faction) throw new Error("Pick a faction for your crew first.");
      await db
        .update(schema.clans)
        .set({ factionPoints: clan.factionPoints + args.points, wins: clan.wins + 1 })
        .where(eq(schema.clans.id, args.clanId));
      await logActivity(ctx, args.clanId, me.gamertag, `earned ${args.points} faction points`, clan.faction, args.reason);
      ctx.invalidateQueries();
      return ok();
    },
  }),

  factionStandings: defineAction({
    description: "Returns the Green vs Purple seasonal faction war standings.",
    request: z.object({}),
    response: z.object({
      greenPoints: z.number(),
      purplePoints: z.number(),
      clans: z.array(
        z.object({ id: z.number(), name: z.string(), tag: z.string(), faction: z.string(), points: z.number() }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.clans);
      const withFaction = rows.filter((r) => r.faction === "Green" || r.faction === "Purple");
      return {
        greenPoints: withFaction.filter((r) => r.faction === "Green").reduce((s, r) => s + r.factionPoints, 0),
        purplePoints: withFaction.filter((r) => r.faction === "Purple").reduce((s, r) => s + r.factionPoints, 0),
        clans: withFaction
          .sort((a, b) => b.factionPoints - a.factionPoints)
          .map((r) => ({ id: r.id, name: r.name, tag: r.tag, faction: r.faction, points: r.factionPoints })),
      };
    },
  }),

  listEvents: defineAction({
    description: "Lists community events for discovery: Public events are visible to everyone; Private events only to members of the host crew (and the host). Search matches the event name, host crew, description and hashtags — a search starting with # (or the hashtag filter) matches hashtags only, so players can find events by name or by hashtag like #carmeet or #race.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      search: z.string().trim().max(120).default(""),
      hashtag: z.string().trim().max(40).default(""),
      typeFilter: z.string().trim().max(40).default("All"),
      platformFilter: z.string().trim().max(10).default("All"),
      visibilityFilter: z.enum(["All", "Public", "Private"]).default("All"),
    }),
    response: z.object({ items: z.array(eventItem) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.events);
      const allRsvps = await db.select().from(schema.rsvps);
      const clans = await db.select().from(schema.clans);
      const clanOf = (id: number | null) => clans.find((c) => c.id === id);
      const myMemberships = await db
        .select()
        .from(schema.clanMembers)
        .where(eq(schema.clanMembers.playerKey, args.playerKey));
      const myClanIds = new Set(myMemberships.map((m) => m.clanId));
      const myLeaderClanIds = new Set(
        myMemberships.filter((m) => m.role === "Leader").map((m) => m.clanId),
      );
      const myProfileRows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const myTag = (myProfileRows[0]?.gamertag ?? "").toLowerCase();
      const viewerPremium = await premiumActiveFor(ctx, args.playerKey);
      const imageUrls = new Map<number, string>();
      for (const r of rows) {
        if (r.imageBlobKey) {
          try { imageUrls.set(r.id, await ctx.blobs.getUrl(r.imageBlobKey)); } catch { /* picture unavailable — the card falls back to the standard artwork */ }
        }
      }
      const kickedRows = await db.select().from(schema.eventKicked).where(eq(schema.eventKicked.playerKey, args.playerKey));
      const kickedEventIds = new Set(kickedRows.map((k) => k.eventId));
      const nowMs = Date.now();
      const rawSearch = args.search.trim().toLowerCase();
      const searchTag = rawSearch.startsWith("#") ? normalizeHashtags(rawSearch)[0] ?? "" : "";
      const nameSearch = searchTag ? "" : rawSearch;
      const tagFilter = normalizeHashtags(args.hashtag)[0] ?? "";
      const items = rows
        .map((r) => {
          const rs = allRsvps.filter((x) => x.eventId === r.id);
          const myStatus = rs.find((x) => x.playerKey === args.playerKey)?.status ?? "";
          const until = eventEarlyAccessUntil(r.createdAt);
          const inEarlyWindow = nowMs < until.getTime();
          const type = displayEventType(r.type);
          const hostClanName = r.hostClanName || (r.clanId ? clanOf(r.clanId)?.name ?? "" : "");
          const going = rs.filter((x) => x.status === "Going").length;
          // The hosting clan's Leader manages this event (edit /
          // Public-Private / results / remove). Legacy clan-less
          // rows fall back to the host.
          const canManage =
            r.clanId != null
              ? myLeaderClanIds.has(r.clanId)
              : myTag !== "" && r.host.toLowerCase() === myTag;
          return {
            id: r.id,
            title: r.title,
            type,
            startsAt: r.startsAt,
            timezone: r.timezone,
            platform: r.platform,
            maxPlayers: r.maxPlayers,
            description: r.description,
            rules: r.rules,
            prize: r.prize,
            host: r.host,
            results: r.results,
            canManage,
            // Lobby details are visible ONLY to players who RSVP'd
            // Going — and to the managing Leader, who wrote them and
            // needs them to edit the event. Nobody else ever gets them.
            lobbyDetails: myStatus === "Going" || canManage ? r.lobbyDetails : "",
            lobbyLink: myStatus === "Going" || canManage ? r.lobbyLink : "",
            // Premium early access: inside the first 48 hours after
            // the event was created, only Premium members can RSVP
            // Going (enforced in rsvpEvent). Someone already Going
            // keeps their spot.
            earlyAccess: inEarlyWindow,
            earlyAccessUntil: inEarlyWindow ? until.toISOString().slice(0, 10) : "",
            canRsvpGoing: !inEarlyWindow || viewerPremium || myStatus === "Going",
            isExample: r.host === "ViceSunshine Community (example)",
            going,
            maybe: rs.filter((x) => x.status === "Maybe").length,
            myRsvp: myStatus,
            visibility: r.visibility === "Private" ? "Private" : "Public",
            hashtags: hashtagsForEvent(type, r.hashtags ?? ""),
            hostClanId: r.clanId ?? 0,
            hostClanName,
            spotsLeft: Math.max(0, r.maxPlayers - going),
            imageUrl: imageUrls.get(r.id) ?? "",
            kicked: kickedEventIds.has(r.id),
            inviteCode:
              r.visibility === "Private" && r.inviteCode &&
              ((r.clanId != null && myClanIds.has(r.clanId)) || (myTag !== "" && r.host.toLowerCase() === myTag))
                ? r.inviteCode
                : "",
          };
        })
        // Private events are invite-only / clan-only: only the host
        // clan's members (and the host) ever see them listed.
        .filter((it) => {
          if (it.visibility !== "Private") return true;
          if (it.hostClanId && myClanIds.has(it.hostClanId)) return true;
          return myTag !== "" && it.host.toLowerCase() === myTag;
        })
        .filter((it) => {
          if (args.visibilityFilter !== "All" && it.visibility !== args.visibilityFilter) return false;
          if (args.typeFilter !== "All" && it.type !== args.typeFilter) return false;
          if (args.platformFilter !== "All" && it.platform !== args.platformFilter && it.platform !== "Both") return false;
          if (tagFilter && !it.hashtags.includes(tagFilter)) return false;
          if (searchTag && !it.hashtags.includes(searchTag)) return false;
          if (nameSearch) {
            const hay = `${it.title} ${it.type} ${it.description} ${it.host} ${it.hostClanName} ${it.hashtags.map((t) => `#${t}`).join(" ")}`.toLowerCase();
            if (!hay.includes(nameSearch)) return false;
          }
          return true;
        })
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      return { items };
    },
  }),

  getMyEventHosting: defineAction({
    description: "Tells the player which of their crews can host Community Events: only the crew Leader can create events, and only when the crew has at least 10 members. Returns every crew the player leads or belongs to with its member count, the player's role, and whether it can host right now (with the reason when it cannot).",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({
      items: z.array(
        z.object({
          clanId: z.number(),
          clanName: z.string(),
          clanTag: z.string(),
          memberCount: z.number(),
          myRole: z.string(),
          isLeader: z.boolean(),
          eligible: z.boolean(),
          reason: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const mems = await db
        .select()
        .from(schema.clanMembers)
        .where(eq(schema.clanMembers.playerKey, args.playerKey));
      const clans = await db.select().from(schema.clans);
      const allMembers = await db.select().from(schema.clanMembers);
      const items = mems.map((m) => {
        const clan = clans.find((c) => c.id === m.clanId);
        const memberCount = allMembers.filter((x) => x.clanId === m.clanId).length;
        const isLeader = m.role === "Leader";
        const eligible = isLeader && memberCount >= 10;
        const reason = eligible
          ? "You can create Community Events for this crew."
          : !isLeader
            ? `Only the crew Leader can create events — you are ${m.role} in this crew.`
            : `Your crew needs at least 10 members to host Community Events — it has ${memberCount} right now.`;
        return {
          clanId: m.clanId,
          clanName: clan?.name ?? "Crew",
          clanTag: clan?.tag ?? "",
          memberCount,
          myRole: m.role,
          isLeader,
          eligible,
          reason,
        };
      });
      return { items };
    },
  }),

  getEventCreationStatus: defineAction({
    description: "Tells the Create Event page where a player stands with the weekly community-event limit: whether they lead any crew, whether they can create an event this week, and — when they already created one — that event's title, when it was created, and the exact date the next creation unlocks (7 days after the last one). It also reports the extra-event option: while the weekly limit blocks them, a Leader can start ONE extra event right away for 200 Vice Credits — this returns that cost, the player's credit balance, and whether they can afford it. The Leader + 10-member rules are reported separately by getMyEventHosting.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({
      isLeader: z.boolean(),
      canCreate: z.boolean(),
      lastTitle: z.string(),
      lastCreatedAt: z.string(),
      nextAvailableAt: z.string(),
      extraEventCost: z.number(),
      creditBalance: z.number(),
      canAffordExtra: z.boolean(),
    }),
    handler: async (ctx, args): Promise<{ isLeader: boolean; canCreate: boolean; lastTitle: string; lastCreatedAt: string; nextAvailableAt: string; extraEventCost: number; creditBalance: number; canAffordExtra: boolean }> => {
      const state = await leaderWeeklyEventState(ctx, args.playerKey);
      const db = ctx.db<typeof schema>();
      const profRows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const balance = profRows[0]?.credits ?? 0;
      return {
        isLeader: state.isLeader,
        canCreate: state.isLeader && state.nextAtMs <= Date.now(),
        lastTitle: state.lastTitle,
        lastCreatedAt: state.lastAtMs > 0 ? new Date(state.lastAtMs).toISOString() : "",
        nextAvailableAt: state.nextAtMs > 0 ? new Date(state.nextAtMs).toISOString() : "",
        extraEventCost: EXTRA_EVENT_COST,
        creditBalance: balance,
        canAffordExtra: balance >= EXTRA_EVENT_COST,
      };
    },
  }),

  createEvent: defineAction({
    description: "Creates a Community Event. Only a crew Leader can create one, and only for a crew with at least 10 members (checked server-side). IN ADDITION, a Leader can create at most ONE community event per week for free — counted across every crew they lead from the events' real creation stamps; a blocked attempt fails with the exact date the next one unlocks. While blocked, the Leader can instead pass useCredits to start the extra event right away for 200 Vice Credits (deducted from their wallet, and the paid event becomes the most recent one for the weekly clock). Events are Public (anyone can see and join) or Private (invite-only — hidden from everyone except the host crew's members, plus anyone the host invites with the event's shareable invite link / invite code, which is generated here for Private events). Hashtags are stored normalised so the event can be found by name or by hashtag.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().min(2).max(32),
      clanId: z.number().int().positive(),
      useCredits: z.boolean().default(false),
      title: z.string().trim().min(4).max(120),
      type: z.string().trim().max(40).default("Car Meet"),
      startsAt: z.string().trim().min(10).max(30),
      timezone: z.string().trim().max(50).default("America/New_York"),
      platform: platformEnum.default("Both"),
      maxPlayers: z.number().int().min(2).max(32).default(16),
      description: z.string().trim().max(2000).default(""),
      rules: z.string().trim().max(1000).default(""),
      prize: z.string().trim().max(120).default("Bragging rights + site badge"),
      visibility: z.enum(["Public", "Private"]).default("Public"),
      hashtags: z.string().trim().max(200).default(""),
      lobbyDetails: z.string().trim().max(1000).default(""),
      lobbyLink: z.string().trim().max(500).default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      assertClean(args.title, args.description, args.rules);
      const me = await myMembership(ctx, args.clanId, args.playerKey);
      if (!me) throw new Error("You are not a member of that crew, so you cannot create an event for it.");
      if (me.role !== "Leader") {
        throw new Error(`Only the crew Leader can create Community Events — you are ${me.role} in this crew. Ask your Leader to create the event.`);
      }
      const members = await db
        .select()
        .from(schema.clanMembers)
        .where(eq(schema.clanMembers.clanId, args.clanId));
      if (members.length < 10) {
        throw new Error(`Your crew needs at least 10 members to host Community Events — it has ${members.length} right now. Recruit ${10 - members.length} more member${10 - members.length === 1 ? "" : "s"} and you can start creating events.`);
      }
      // Weekly limit — in addition to the Leader + 10-member rules
      // above, never instead of them: one free event per Leader per
      // week, across every crew they lead. While blocked, the Leader
      // can start this extra event right away for EXTRA_EVENT_COST
      // Vice Credits (useCredits) — one of only two things credits
      // are ever for. The paid event is created like any other, so
      // it becomes the most recent event for the weekly clock.
      const weekly = await leaderWeeklyEventState(ctx, args.playerKey);
      if (weekly.nextAtMs > Date.now()) {
        const nextDate = new Date(weekly.nextAtMs).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
        if (!args.useCredits) {
          throw new Error(`You already created a community event this week${weekly.lastTitle ? ` ("${weekly.lastTitle}")` : ""}. Leaders can create one free community event per week — your next free one unlocks on ${nextDate}. To start this extra event right away instead, turn on the ${EXTRA_EVENT_COST} Vice Credits option on the Create Event form.`);
        }
        const profRows = await db
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.playerKey, args.playerKey));
        const balance = profRows[0]?.credits ?? 0;
        if (balance < EXTRA_EVENT_COST) {
          throw new Error(`An extra community event costs ${EXTRA_EVENT_COST} Vice Credits and you have ${balance}. Earn more from in-app activity — or wait for your next free event on ${nextDate}.`);
        }
        await creditPersonalWallet(ctx, args.playerKey, -EXTRA_EVENT_COST, `Extra community event — ${args.title}`);
      }
      const clanRows = await db.select().from(schema.clans).where(eq(schema.clans.id, args.clanId));
      const clan = clanRows[0];
      const type = displayEventType(args.type);
      const tags = hashtagsForEvent(type, args.hashtags);
      // Private events get a shareable invite code (the invite link
      // carries it as #event=CODE). Anyone with the code can view
      // and join this one event; nobody else can even see it listed.
      let inviteCode = "";
      if (args.visibility === "Private") {
        const existing = await db.select().from(schema.events);
        const used = new Set(existing.map((e) => e.inviteCode).filter(Boolean));
        inviteCode = newInviteCode();
        while (used.has(inviteCode)) inviteCode = newInviteCode();
      }
      const res = await db
        .insert(schema.events)
        .values({
          title: args.title,
          type,
          startsAt: args.startsAt,
          timezone: args.timezone,
          platform: args.platform,
          maxPlayers: args.maxPlayers,
          description: args.description,
          rules: args.rules,
          prize: args.prize,
          host: args.gamertag,
          lobbyDetails: args.lobbyDetails,
          lobbyLink: args.lobbyLink,
          clanId: args.clanId,
          visibility: args.visibility,
          hashtags: tags.join(" "),
          hostClanName: clan?.name ?? "",
          inviteCode,
          results: "",
        })
        .returning({ id: schema.events.id });
      const clanRows2 = await db.select().from(schema.clans).where(eq(schema.clans.id, args.clanId));
      const c2 = clanRows2[0];
      if (c2) {
        await db
          .update(schema.clans)
          .set({ eventsHeld: c2.eventsHeld + 1 })
          .where(eq(schema.clans.id, args.clanId));
      }
      await logActivity(ctx, args.clanId, args.gamertag, "created a Community Event:", args.title, args.visibility === "Private" ? "Private event" : "Public event");
      ctx.invalidateQueries();
      return { id: res[0]?.id ?? 0 };
    },
  }),

  updateEvent: defineAction({
    description: "Edits a Community Event — only the Leader of the hosting crew can do this (checked server-side). The Leader can change everything about the event, including switching it between Public and Private: switching to Private generates a fresh invite code/link (any old code stops working), switching to Public clears the invite code and lists the event for everyone. The 10-member minimum is a creation gate only — a Leader keeps control of an existing event even if the crew later drops below 10 members.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().min(2).max(32),
      eventId: z.number().int().positive(),
      title: z.string().trim().min(4).max(120),
      type: z.string().trim().max(40).default("Car Meet"),
      startsAt: z.string().trim().min(10).max(30),
      timezone: z.string().trim().max(50).default("America/New_York"),
      platform: platformEnum.default("Both"),
      maxPlayers: z.number().int().min(2).max(32).default(16),
      description: z.string().trim().max(2000).default(""),
      rules: z.string().trim().max(1000).default(""),
      prize: z.string().trim().max(120).default("Bragging rights + site badge"),
      visibility: z.enum(["Public", "Private"]).default("Public"),
      hashtags: z.string().trim().max(200).default(""),
      lobbyDetails: z.string().trim().max(1000).default(""),
      lobbyLink: z.string().trim().max(500).default(""),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      assertClean(args.title, args.description, args.rules);
      const rows = await db.select().from(schema.events).where(eq(schema.events.id, args.eventId));
      const ev = rows[0];
      if (!ev) throw new Error("Event not found.");
      if (!(await isEventManager(ctx, ev, args.playerKey, args.gamertag))) {
        throw new Error("Only the Leader of the hosting crew can edit this event.");
      }
      const type = displayEventType(args.type);
      const tags = hashtagsForEvent(type, args.hashtags);
      // Visibility switches: going Private mints a fresh invite code
      // (an old shared code must not keep working); going Public
      // clears it — the event is listed for everyone instead.
      let inviteCode = ev.inviteCode;
      if (args.visibility === "Private" && ev.visibility !== "Private") {
        const existing = await db.select().from(schema.events);
        const used = new Set(existing.map((e) => e.inviteCode).filter(Boolean));
        inviteCode = newInviteCode();
        while (used.has(inviteCode)) inviteCode = newInviteCode();
      }
      if (args.visibility === "Public") inviteCode = "";
      await db
        .update(schema.events)
        .set({
          title: args.title,
          type,
          startsAt: args.startsAt,
          timezone: args.timezone,
          platform: args.platform,
          maxPlayers: args.maxPlayers,
          description: args.description,
          rules: args.rules,
          prize: args.prize,
          visibility: args.visibility,
          hashtags: tags.join(" "),
          lobbyDetails: args.lobbyDetails,
          lobbyLink: args.lobbyLink,
          inviteCode,
        })
        .where(eq(schema.events.id, args.eventId));
      if (ev.clanId) {
        await logActivity(ctx, ev.clanId, args.gamertag, "edited a Community Event:", args.title, args.visibility === "Private" ? "Now Private" : "Now Public");
      }
      ctx.invalidateQueries();
      return ok();
    },
  }),

  deleteEvent: defineAction({
    description: "Removes a Community Event completely, including all its RSVPs — only the Leader of the hosting crew can do this (checked server-side).",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().min(2).max(32),
      eventId: z.number().int().positive(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.events).where(eq(schema.events.id, args.eventId));
      const ev = rows[0];
      if (!ev) throw new Error("Event not found.");
      if (!(await isEventManager(ctx, ev, args.playerKey, args.gamertag))) {
        throw new Error("Only the Leader of the hosting crew can remove this event.");
      }
      if (ev.clanId) {
        await logActivity(ctx, ev.clanId, args.gamertag, "removed a Community Event:", ev.title, "");
      }
      await db.delete(schema.rsvps).where(eq(schema.rsvps.eventId, args.eventId));
      await db.delete(schema.events).where(eq(schema.events.id, args.eventId));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  getEventByInviteCode: defineAction({
    description: "Looks up ONE event by its private-event invite code (from an invite link #event=CODE or a code the host shared). Returns the event in the same shape as listEvents so the player can view it and RSVP — the code itself is the invitation, so it works for players outside the host crew. Returns item: null when no event matches the code.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      code: z.string().trim().min(4).max(12),
    }),
    response: z.object({ item: eventItem.nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const code = normalizeInviteCode(args.code);
      if (!code) return { item: null };
      const rows = await db.select().from(schema.events);
      const r = rows.find((e) => e.inviteCode !== "" && e.inviteCode === code);
      if (!r) return { item: null };
      const allRsvps = await db.select().from(schema.rsvps);
      const clans = await db.select().from(schema.clans);
      const rs = allRsvps.filter((x) => x.eventId === r.id);
      const myStatus = rs.find((x) => x.playerKey === args.playerKey)?.status ?? "";
      const viewerPremium = await premiumActiveFor(ctx, args.playerKey);
      const until = eventEarlyAccessUntil(r.createdAt);
      const inEarlyWindow = Date.now() < until.getTime();
      const type = displayEventType(r.type);
      const going = rs.filter((x) => x.status === "Going").length;
      const myProfileRows2 = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const canManage = await isEventManager(ctx, r, args.playerKey, myProfileRows2[0]?.gamertag ?? "");
      return {
        item: {
          id: r.id,
          title: r.title,
          type,
          startsAt: r.startsAt,
          timezone: r.timezone,
          platform: r.platform,
          maxPlayers: r.maxPlayers,
          description: r.description,
          rules: r.rules,
          prize: r.prize,
          host: r.host,
          results: r.results,
          canManage,
          lobbyDetails: myStatus === "Going" || canManage ? r.lobbyDetails : "",
          lobbyLink: myStatus === "Going" || canManage ? r.lobbyLink : "",
          earlyAccess: inEarlyWindow,
          earlyAccessUntil: inEarlyWindow ? until.toISOString().slice(0, 10) : "",
          canRsvpGoing: !inEarlyWindow || viewerPremium || myStatus === "Going",
          isExample: r.host === "ViceSunshine Community (example)",
          going,
          maybe: rs.filter((x) => x.status === "Maybe").length,
          myRsvp: myStatus,
          visibility: r.visibility === "Private" ? "Private" : "Public",
          hashtags: hashtagsForEvent(type, r.hashtags ?? ""),
          hostClanId: r.clanId ?? 0,
          hostClanName: r.hostClanName || (r.clanId ? clans.find((c) => c.id === r.clanId)?.name ?? "" : ""),
          spotsLeft: Math.max(0, r.maxPlayers - going),
          // The finder arrived WITH the code — echo it back so the
          // client can pass it to rsvpEvent.
          imageUrl: r.imageBlobKey ? await ctx.blobs.getUrl(r.imageBlobKey).catch(() => "") : "",
          kicked: (await db.select().from(schema.eventKicked).where(and(eq(schema.eventKicked.eventId, r.id), eq(schema.eventKicked.playerKey, args.playerKey)))).length > 0,
          inviteCode: r.inviteCode,
        },
      };
    },
  }),

  rsvpEvent: defineAction({
    description: "Sets the player's RSVP for an event.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().min(2).max(32),
      eventId: z.number().int().positive(),
      status: z.enum(["Going", "Maybe", "Can't Go"]),
      // For a Private event, the invite code the host shared admits
      // a player who is not in the host clan.
      inviteCode: z.string().trim().max(12).default(""),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      // Private events are invite-only / clan-only: only members of
      // the host clan (and the host) can RSVP at all.
      const evCheck = await db.select().from(schema.events).where(eq(schema.events.id, args.eventId));
      const evRow0 = evCheck[0];
      if (!evRow0) throw new Error("Event not found.");
      if (evRow0.visibility === "Private") {
        const isHost = evRow0.host.toLowerCase() === args.gamertag.toLowerCase();
        let inClan = false;
        if (evRow0.clanId) {
          const mem = await myMembership(ctx, evRow0.clanId, args.playerKey);
          inClan = Boolean(mem);
        }
        const hasInvite =
          evRow0.inviteCode !== "" &&
          normalizeInviteCode(args.inviteCode) === evRow0.inviteCode;
        if (!isHost && !inClan && !hasInvite) {
          throw new Error(`This is a private event — it is only open to members of ${evRow0.hostClanName || "the host crew"}, or to players with the event's invite code. Ask the host for the invite link or code.`);
        }
      }
      const kicked = await db
        .select()
        .from(schema.eventKicked)
        .where(and(eq(schema.eventKicked.eventId, args.eventId), eq(schema.eventKicked.playerKey, args.playerKey)));
      if (kicked.length > 0) {
        throw new Error("The host removed you from this event, so you can't join it again. If you think that was a mistake, talk to the host crew's Leader.");
      }
      const rows = await db
        .select()
        .from(schema.rsvps)
        .where(and(eq(schema.rsvps.eventId, args.eventId), eq(schema.rsvps.playerKey, args.playerKey)));
      const wasGoing = rows[0]?.status === "Going";
      if (args.status === "Going" && !wasGoing) {
        const evRows = await db.select().from(schema.events).where(eq(schema.events.id, args.eventId));
        const evRow = evRows[0];
        if (evRow && Date.now() < eventEarlyAccessUntil(evRow.createdAt).getTime()) {
          const isPremium = await premiumActiveFor(ctx, args.playerKey);
          if (!isPremium) {
            throw new Error(`This event is in its Premium early-access window — Premium members can RSVP Going now, and Going opens to everyone on ${eventEarlyAccessUntil(evRow.createdAt).toISOString().slice(0, 10)}. You can still RSVP Maybe.`);
          }
        }
      }
      if (rows[0]) {
        await db
          .update(schema.rsvps)
          .set({ status: args.status, gamertag: args.gamertag })
          .where(eq(schema.rsvps.id, rows[0].id));
      } else {
        await db.insert(schema.rsvps).values(args);
      }
      // Attendance points are counted automatically from the in-app
      // RSVP — the action happened in ViceSunshine, so the app can count it.
      if (args.status === "Going" && !wasGoing) {
        const evs = await db.select().from(schema.events).where(eq(schema.events.id, args.eventId));
        await recordPoints(ctx, {
          playerKey: args.playerKey,
          gamertag: args.gamertag,
          targetClanId: null,
          points: POINT_RATES.eventAttend,
          source: "event",
          sourceRef: `event-attend:${args.eventId}`,
          reason: `RSVP'd Going to community event: ${evs[0]?.title ?? "event"}`,
          verifiedBy: "ViceSunshine (in-app RSVP)",
        });
      }
      ctx.invalidateQueries();
      return ok();
    },
  }),

  eventAttendees: defineAction({
    description: "Lists attendees for one event.",
    request: z.object({ eventId: z.number().int().positive() }),
    response: z.object({
      items: z.array(z.object({ playerKey: z.string(), gamertag: z.string(), status: z.string(), inVoice: z.boolean() })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.rsvps)
        .where(eq(schema.rsvps.eventId, args.eventId));
      return {
        items: rows.map((r) => ({
          playerKey: r.playerKey,
          gamertag: r.gamertag,
          status: r.status,
          inVoice: false,
        })),
      };
    },
  }),

  removeEventAttendee: defineAction({
    description: "Removes (kicks) one attendee from a Community Event — only the event's manager (the hosting crew's Leader) can do this. The player's RSVP is deleted and they are recorded as kicked, so they cannot RSVP to that event again.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().min(2).max(32),
      eventId: z.number().int().positive(),
      attendeeKey: z.string().min(1).max(80),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.events).where(eq(schema.events.id, args.eventId));
      const ev = rows[0];
      if (!ev) throw new Error("Event not found.");
      if (!(await isEventManager(ctx, ev, args.playerKey, args.gamertag))) {
        throw new Error("Only the hosting crew's Leader can remove someone from this event.");
      }
      if (args.attendeeKey === args.playerKey) {
        throw new Error("You are the host — you can't remove yourself. Remove the event instead if it should not run.");
      }
      const rsvpRows = await db
        .select()
        .from(schema.rsvps)
        .where(and(eq(schema.rsvps.eventId, args.eventId), eq(schema.rsvps.playerKey, args.attendeeKey)));
      const target = rsvpRows[0];
      if (!target) throw new Error("That player is not on this event's list.");
      if (target.gamertag.toLowerCase() === ev.host.toLowerCase() && ev.clanId == null) {
        throw new Error("The host cannot be removed from their own event.");
      }
      await db.delete(schema.rsvps).where(eq(schema.rsvps.id, target.id));
      const already = await db
        .select()
        .from(schema.eventKicked)
        .where(and(eq(schema.eventKicked.eventId, args.eventId), eq(schema.eventKicked.playerKey, args.attendeeKey)));
      if (already.length === 0) {
        await db.insert(schema.eventKicked).values({ eventId: args.eventId, playerKey: args.attendeeKey, gamertag: target.gamertag });
      }
      ctx.invalidateQueries();
      return ok();
    },
  }),

  setEventImage: defineAction({
    description: "Uploads the Community Event's picture — only the event's manager (the hosting crew's Leader) can do this. JPG or PNG, up to 4 MB, checked by automatic moderation BEFORE it is stored, exactly like avatar uploads. The picture becomes the event card's banner everywhere the event shows.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().min(2).max(32),
      eventId: z.number().int().positive(),
      filename: z.string().trim().min(1).max(120),
      mimeType: z.string().min(3).max(60),
      dataBase64: z.string().min(10).max(6000000),
    }),
    response: z.object({ url: z.string() }),
    async handler(ctx, args) {
      if (args.mimeType !== "image/jpeg" && args.mimeType !== "image/png") {
        throw new Error("Event pictures must be JPG or PNG — those are the formats the automatic safety check can read, so no picture can skip the check.");
      }
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.events).where(eq(schema.events.id, args.eventId));
      const ev = rows[0];
      if (!ev) throw new Error("Event not found.");
      if (!(await isEventManager(ctx, ev, args.playerKey, args.gamertag))) {
        throw new Error("Only the hosting crew's Leader can set this event's picture.");
      }
      const bytes = Buffer.from(args.dataBase64, "base64");
      if (bytes.length > 4 * 1024 * 1024) {
        throw new Error("That picture is over the 4 MB limit — please compress it and try again.");
      }
      await assertImageAllowed(ctx, args.dataBase64, args.mimeType, args.filename, "picture");
      const safeName = args.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
      const key = `events/${args.eventId}/${Date.now()}-${safeName}`;
      await ctx.blobs.put(key, bytes, { contentType: args.mimeType });
      await db.update(schema.events).set({ imageBlobKey: key }).where(eq(schema.events.id, args.eventId));
      const url = await ctx.blobs.getUrl(key);
      ctx.invalidateQueries();
      return { url };
    },
  }),

  removeEventImage: defineAction({
    description: "Removes a Community Event's uploaded picture (the hosting crew's Leader only), so the event card goes back to the standard events artwork.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().min(2).max(32),
      eventId: z.number().int().positive(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.events).where(eq(schema.events.id, args.eventId));
      const ev = rows[0];
      if (!ev) throw new Error("Event not found.");
      if (!(await isEventManager(ctx, ev, args.playerKey, args.gamertag))) {
        throw new Error("Only the hosting crew's Leader can change this event's picture.");
      }
      await db.update(schema.events).set({ imageBlobKey: "" }).where(eq(schema.events.id, args.eventId));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  setEventResults: defineAction({
    description: "Posts results / leaderboard notes on an event after it runs. Only the Leader of the hosting crew (the event's manager) can post results — checked server-side.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().min(2).max(32),
      eventId: z.number().int().positive(),
      results: z.string().trim().max(2000),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.events).where(eq(schema.events.id, args.eventId));
      const ev = rows[0];
      if (!ev) throw new Error("Event not found.");
      if (!(await isEventManager(ctx, ev, args.playerKey, args.gamertag))) {
        throw new Error("Only the Leader of the hosting crew can post results for this event.");
      }
      await db.update(schema.events).set({ results: args.results }).where(eq(schema.events.id, args.eventId));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  listFeed: defineAction({
    description: "Lists public community feed posts, newest first, with like/comment counts and the viewer's state. followingOnly narrows the list to the viewer's own posts plus posts from players they follow (the Feed's Following tab); Automatic posts have no followable author and stay on the For you tab.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      kind: z.string().max(30).default("All"),
      search: z.string().max(120).default(""),
      source: z.enum(["All", "Automatic", "Community"]).default("All"),
      sort: z.enum(["Latest", "Top"]).default("Latest"),
      followingOnly: z.boolean().default(false),
    }),
    response: z.object({
      items: z.array(
        z.object({
          id: z.number(),
          author: z.string(),
          kind: z.string(),
          body: z.string(),
          mediaUrl: z.string(),
          auto: z.boolean(),
          sourceName: z.string(),
          sourceUrl: z.string(),
          likes: z.number(),
          likedByMe: z.boolean(),
          commentCount: z.number(),
          views: z.number(),
          shares: z.number(),
          reports: z.number(),
          flagged: z.boolean(),
          mine: z.boolean(),
          authorNameColor: z.string(),
          authorFrame: z.string(),
          authorAvatarUrl: z.string(),
          authorBadge: z.string(),
          title: z.string(),
          mediaType: z.string(),
          embedUrl: z.string(),
          videoId: z.string(),
          hasNewsImage: z.boolean(),
          isExample: z.boolean(),
          reposts: z.number(),
          repostedByMe: z.boolean(),
          repostOf: z
            .object({
              id: z.number(),
              author: z.string(),
              auto: z.boolean(),
              sourceName: z.string(),
              sourceUrl: z.string(),
              title: z.string(),
              body: z.string(),
              kind: z.string(),
              mediaUrl: z.string(),
              mediaType: z.string(),
              embedUrl: z.string(),
              videoId: z.string(),
            })
            .nullable(),
          createdAt: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let rows = await db.select().from(schema.feedPosts).orderBy(desc(schema.feedPosts.id));
      const profileMap = await profilesByKey(ctx);
      const artUrls = await avatarArtUrls(ctx);
      const customArt = await customAvatarUrls(ctx);
      const reactions = await db.select().from(schema.feedReactions);
      const comments = await db.select().from(schema.feedComments);
      const viewRows = await db.select().from(schema.feedViews);
      const reports = await db.select().from(schema.feedReports);
      const hidden = await db
        .select()
        .from(schema.feedHidden)
        .where(eq(schema.feedHidden.playerKey, args.playerKey));
      const hiddenSet = new Set(hidden.map((h) => h.postId));
      rows = rows.filter((r) => !hiddenSet.has(r.id));
      const blockedSet = await blockedKeysFor(ctx, args.playerKey);
      if (blockedSet.size > 0) rows = rows.filter((r) => !blockedSet.has(r.authorKey));
      // Players who blocked ME disappear from my Feed too — blocking
      // works both ways.
      const blockedBySet = await blockedByKeysFor(ctx, args.playerKey);
      if (blockedBySet.size > 0) rows = rows.filter((r) => !blockedBySet.has(r.authorKey));
      // Private accounts: their posts are only for their followers
      // (and themselves). Automatic posts have no profile, so they
      // are never private.
      const myFollowRows = await db.select().from(schema.profileFollows).where(eq(schema.profileFollows.followerKey, args.playerKey));
      const myFollowingSet = new Set(myFollowRows.map((f) => f.followingKey));
      rows = rows.filter((r) => {
        if (r.authorKey === args.playerKey) return true;
        const authorProfile = profileMap.get(r.authorKey);
        if (authorProfile && authorProfile.profilePrivate === 1 && !myFollowingSet.has(r.authorKey)) return false;
        return true;
      });
      // Following tab: only the viewer's own posts and posts from
      // players they follow. Automatic posts have no author to
      // follow, so they never appear here.
      if (args.followingOnly) {
        rows = rows.filter((r) => r.authorKey === args.playerKey || myFollowingSet.has(r.authorKey));
      }
      // Automatic moderation: a flagged post (3+ reports, or caught
      // by the automatic sweep) is hidden from everyone except its
      // author while it is under review.
      rows = rows.filter((r) => r.flagged !== 1 || r.authorKey === args.playerKey);
      // TikTok clips live ONLY in the Clips section (the owner's
      // split: the Feed keeps its own videos exactly as they are;
      // Clips is TikTok-sourced). TikTok rows are stored as feed
      // posts so likes / comments / shares work in Clips, but they
      // never appear in the Feed itself.
      rows = rows.filter((r) => !tiktokIdOf(r.mediaUrl));
      if (args.source === "Automatic") rows = rows.filter((r) => r.auto === 1);
      if (args.source === "Community") rows = rows.filter((r) => r.auto !== 1);
      if (args.kind !== "All") {
        const kinds = FEED_KIND_TABS[args.kind];
        rows = kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows.filter((r) => r.kind === args.kind);
      }
      const q = args.search.trim().toLowerCase();
      if (q) {
        rows = rows.filter(
          (r) =>
            r.body.toLowerCase().includes(q) ||
            r.author.toLowerCase().includes(q) ||
            r.title.toLowerCase().includes(q),
        );
      }
      // Repost counts are always counted against the ROOT original,
      // so a repost row shows the same count as the post it credits.
      const repostRows = await db.select().from(schema.feedReposts);
      const repostCountOf = (rootId: number) => repostRows.filter((x) => x.postId === rootId).length;
      const rootIdOf = (r: (typeof rows)[number]) => (r.repostOfId > 0 ? r.repostOfId : r.id);
      const likeCountOf = (id: number) => reactions.filter((x) => x.postId === id).length;
      if (args.sort === "Top") {
        // Most reposted first, then most liked, then newest — the
        // clips the community shares most rise to the top of the Feed.
        rows = [...rows].sort(
          (a, b) =>
            repostCountOf(rootIdOf(b)) - repostCountOf(rootIdOf(a)) ||
            likeCountOf(rootIdOf(b)) - likeCountOf(rootIdOf(a)) ||
            b.id - a.id,
        );
      }
      const allById = new Map((await db.select().from(schema.feedPosts)).map((r) => [r.id, r]));
      // Editorial news pictures live in blob storage; resolve their
      // URLs once for the page of posts (and any repost roots).
      const imageUrlOf = new Map<number, string>();
      const imageCandidates = new Map<number, string>();
      for (const r of rows.slice(0, 100)) if (r.imageBlobKey) imageCandidates.set(r.id, r.imageBlobKey);
      for (const r of rows.slice(0, 100)) {
        const root = r.repostOfId > 0 ? allById.get(r.repostOfId) : undefined;
        if (root?.imageBlobKey) imageCandidates.set(root.id, root.imageBlobKey);
      }
      for (const [id, key] of imageCandidates) {
        try {
          imageUrlOf.set(id, await ctx.blobs.getUrl(key));
        } catch { /* picture missing — post renders without it */ }
      }
      const withImage = (m: { mediaType: string; embedUrl: string; videoId: string }, imgUrl: string) =>
        m.mediaType === "none" && imgUrl ? { mediaType: "image", embedUrl: "", videoId: "" } : m;
      return {
        items: rows.slice(0, 100).map((r) => {
          const root = r.repostOfId > 0 ? (allById.get(r.repostOfId) ?? null) : null;
          const imgUrl = imageUrlOf.get(r.id) ?? "";
          const media = withImage(feedMediaOf(r.mediaUrl), imgUrl);
          const rootImg = root ? (imageUrlOf.get(root.id) ?? "") : "";
          const rootMedia = root ? withImage(feedMediaOf(root.mediaUrl), rootImg) : null;
          return {
            id: r.id,
            author: r.author,
            kind: r.kind,
            // YouTube posts never show the raw video URL as body text —
            // the embedded player at the top of the card is how you watch.
            body: media.mediaType === "youtube" ? stripVideoUrlsFromBody(r.body, r.mediaUrl) : r.body,
            mediaUrl: media.mediaType === "image" && imgUrl ? imgUrl : r.mediaUrl,
            auto: r.auto === 1,
            sourceName: r.sourceName,
            sourceUrl: r.sourceUrl,
            likes: likeCountOf(r.id),
            likedByMe: reactions.some((x) => x.postId === r.id && x.playerKey === args.playerKey),
            commentCount: comments.filter((x) => x.postId === r.id).length,
            views: viewRows.filter((x) => x.postId === r.id).length,
            shares: r.shares,
            reports: reports.filter((x) => x.postId === r.id).length,
            flagged: r.flagged === 1,
            mine: r.authorKey === args.playerKey,
            title: r.title,
            ...media,
            hasNewsImage: Boolean(imgUrl),
            isExample: r.authorKey === FEED_EXAMPLE_KEY,
            reposts: repostCountOf(rootIdOf(r)),
            repostedByMe: repostRows.some((x) => x.postId === rootIdOf(r) && x.playerKey === args.playerKey),
            repostOf: root
              ? {
                  id: root.id,
                  author: root.author,
                  auto: root.auto === 1,
                  sourceName: root.sourceName,
                  sourceUrl: root.sourceUrl,
                  title: root.title,
                  body:
                    rootMedia?.mediaType === "youtube"
                      ? stripVideoUrlsFromBody(root.body, root.mediaUrl)
                      : root.body,
                  kind: root.kind,
                  mediaUrl: rootMedia?.mediaType === "image" && rootImg ? rootImg : root.mediaUrl,
                  ...(rootMedia ?? feedMediaOf(root.mediaUrl)),
                }
              : null,
            authorNameColor: "",
            authorFrame: "",
            authorAvatarUrl: pickAvatar(artUrls, customArt, profileMap.get(r.authorKey)),
            authorBadge: profileMap.get(r.authorKey)?.badge ?? "",
            createdAt: r.createdAt.toISOString(),
          };
        }),
      };
    },
  }),

  listClips: defineAction({
    description: "Lists the Clips section: TikTok GTA VI clips (validated playable through TikTok's oEmbed before they are shown, played via TikTok's official player, credited to the creator with a link to the original TikTok) plus clips uploaded natively to ViceSunshine. YouTube posts are never returned here — Clips does not use YouTube.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
    }),
    response: z.object({
      items: z.array(
        z.object({
          id: z.number(),
          author: z.string(),
          kind: z.string(),
          title: z.string(),
          body: z.string(),
          mediaUrl: z.string(),
          sourceName: z.string(),
          sourceUrl: z.string(),
          isTikTok: z.boolean(),
          tiktokId: z.string(),
          tiktokHandle: z.string(),
          embedUrl: z.string(),
          likes: z.number(),
          likedByMe: z.boolean(),
          commentCount: z.number(),
          views: z.number(),
          shares: z.number(),
          reposts: z.number(),
          repostedByMe: z.boolean(),
          createdAt: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      await ensureTikTokClips(ctx);
      const db = ctx.db<typeof schema>();
      let rows = await db.select().from(schema.feedPosts).orderBy(desc(schema.feedPosts.id));
      const hidden = await db
        .select()
        .from(schema.feedHidden)
        .where(eq(schema.feedHidden.playerKey, args.playerKey));
      const hiddenSet = new Set(hidden.map((h) => h.postId));
      rows = rows.filter((r) => !hiddenSet.has(r.id));
      const blockedSet = await blockedKeysFor(ctx, args.playerKey);
      if (blockedSet.size > 0) rows = rows.filter((r) => !blockedSet.has(r.authorKey));
      // Clips = TikTok posts + native uploads only. No YouTube, ever.
      const candidates = rows.filter((r) => {
        if (tiktokIdOf(r.mediaUrl)) return true;
        const m = feedMediaOf(r.mediaUrl);
        return m.mediaType === "video";
      });
      // Playability gate: a TikTok clip is shown only while TikTok's
      // oEmbed confirms it exists and allows embedding. Checked in
      // parallel chunks; a network failure keeps the clip (the
      // client player falls back to a credited link card, never a
      // black box).
      const playable = new Map<number, boolean>();
      for (let i = 0; i < candidates.length; i += 8) {
        const chunk = candidates.slice(i, i + 8);
        const verdicts = await Promise.all(
          chunk.map((r) => {
            const tid = tiktokIdOf(r.mediaUrl);
            return tid ? tiktokEmbeddable(r.mediaUrl) : Promise.resolve(true);
          }),
        );
        chunk.forEach((r, j) => playable.set(r.id, verdicts[j] ?? true));
      }
      const kept = candidates.filter((r) => playable.get(r.id) !== false).slice(0, 30);
      const reactions = await db.select().from(schema.feedReactions);
      const comments = await db.select().from(schema.feedComments);
      const viewRows = await db.select().from(schema.feedViews);
      const repostRows = await db.select().from(schema.feedReposts);
      const rootIdOfClip = (r: (typeof rows)[number]) => (r.repostOfId > 0 ? r.repostOfId : r.id);
      return {
        items: kept.map((r) => {
          const tid = tiktokIdOf(r.mediaUrl);
          const handle = tiktokHandleOf(r.mediaUrl) || r.author;
          return {
            id: r.id,
            author: r.author,
            kind: r.kind,
            title: r.title,
            body: r.body,
            mediaUrl: r.mediaUrl,
            sourceName: r.sourceName,
            sourceUrl: r.sourceUrl,
            isTikTok: Boolean(tid),
            tiktokId: tid,
            tiktokHandle: tid ? handle : "",
            // TikTok's official player endpoint (the src its oEmbed
            // returns): muted autoplay is requested in the client.
            embedUrl: tid ? `https://www.tiktok.com/player/v1/${tid}` : "",
            likes: reactions.filter((x) => x.postId === r.id).length,
            likedByMe: reactions.some((x) => x.postId === r.id && x.playerKey === args.playerKey),
            commentCount: comments.filter((x) => x.postId === r.id).length,
            views: viewRows.filter((x) => x.postId === r.id).length,
            shares: r.shares,
            reposts: repostRows.filter((x) => x.postId === rootIdOfClip(r)).length,
            repostedByMe: repostRows.some((x) => x.postId === rootIdOfClip(r) && x.playerKey === args.playerKey),
            createdAt: r.createdAt.toISOString(),
          };
        }),
      };
    },
  }),

  refreshTikTokClips: defineAction({
    description: "Refreshes the Clips section's TikTok source: prunes automatic TikTok clips TikTok now says are gone or unembeddable, re-seeds the curated GTA VI TikTok clips, and searches the web for more real GTA VI TikTok clips — storing only ones TikTok's oEmbed confirms can be embedded and played, credited to the original creator with a link to the original TikTok. Nothing is downloaded or re-uploaded.",
    request: z.object({}),
    response: z.object({ added: z.number(), checkedAt: z.string() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const lastClipsRefresh = await getMeta(ctx, "last_tiktok_clips_refresh_at");
      if (lastClipsRefresh && Date.now() - new Date(lastClipsRefresh).getTime() < 5 * 60 * 1000) {
        return { added: 0, checkedAt: lastClipsRefresh };
      }
      // Prune automatic TikTok rows that are definitively dead, so
      // Clips can never sit on an unplayable clip.
      const existing = await db.select().from(schema.feedPosts);
      const autoTikTok = existing.filter((r) => r.auto === 1 && tiktokIdOf(r.mediaUrl));
      for (let i = 0; i < autoTikTok.length; i += 8) {
        const chunk = autoTikTok.slice(i, i + 8);
        const verdicts = await Promise.all(chunk.map((r) => tiktokDefinitivelyDead(r.mediaUrl)));
        for (let j = 0; j < chunk.length; j++) {
          const row = chunk[j];
          if (row && verdicts[j]) {
            await db.delete(schema.feedPosts).where(eq(schema.feedPosts.id, row.id));
          }
        }
      }
      let added = await ensureTikTokClips(ctx);
      // Web search for more GTA VI TikTok clips.
      const fresh = await db.select().from(schema.feedPosts);
      const seenIds = new Set(fresh.map((r) => tiktokIdOf(r.mediaUrl)).filter(Boolean));
      const seenTitles = new Set(fresh.map((r) => r.title.toLowerCase()).filter(Boolean));
      const queries = [
        "site:tiktok.com GTA VI clip",
        "site:tiktok.com GTA 6 gameplay clip",
        "site:tiktok.com GTA VI funny clip",
      ];
      for (const q of queries) {
        if (added >= 12) break;
        let results: { title?: string; url?: string }[] = [];
        try {
          const raw = (await ctx.tool.web_search(q)) as unknown;
          const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
          const container = parsed as {
            content?: { results?: Record<string, unknown>[] };
            results?: Record<string, unknown>[];
          };
          const list = container?.content?.results ?? container?.results ?? (Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []);
          results = list.map((r) => ({
            title: typeof r.title === "string" ? r.title : undefined,
            url: typeof r.url === "string" ? r.url : undefined,
          }));
        } catch {
          results = [];
        }
        let perQuery = 0;
        for (const r of results) {
          if (perQuery >= 3 || added >= 12) break;
          const rawUrl = (r.url ?? "").trim();
          const videoId = tiktokIdOf(rawUrl);
          const handle = tiktokHandleOf(rawUrl);
          if (!videoId || !handle || seenIds.has(videoId)) continue;
          const title = stripEmoji((r.title ?? "").replace(/\s+/g, " ").trim());
          if (/leak|download|apk|crack|free gta|mod menu/i.test(title)) continue;
          if (title && seenTitles.has(title.toLowerCase())) continue;
          const permalink = tiktokPermalink(handle, videoId);
          if (!(await tiktokEmbeddable(permalink))) continue;
          seenIds.add(videoId);
          if (title) seenTitles.add(title.toLowerCase());
          await db.insert(schema.feedPosts).values({
            authorKey: TIKTOK_AUTO_KEY,
            author: handle,
            kind: "Clip",
            title: (title || "GTA VI clip").slice(0, 140),
            body: `GTA VI clip from TikTok — credit to @${handle} on TikTok. It plays here from TikTok; watch the original at the source.`,
            mediaUrl: permalink,
            auto: 1,
            sourceName: "TikTok",
            sourceUrl: permalink,
          });
          added += 1;
          perQuery += 1;
        }
      }
      const now = new Date().toISOString();
      await setMeta(ctx, "last_tiktok_clips_refresh_at", now);
      ctx.invalidateQueries();
      return { added, checkedAt: now };
    },
  }),

  repostFeedPost: defineAction({
    description: "Reposts any Feed post (simple repost, or a Quote Repost with the reposter's own comment on top). The new post credits the original poster / source and links back to the original — media is linked, never re-uploaded, and a repost never presents someone else's post as your own. One repost per player per original; reposts of reposts credit the root original, whose poster is notified.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().min(2).max(32),
      postId: z.number().int().positive(),
      comment: z.string().trim().max(500).default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      const rows = await db.select().from(schema.feedPosts).where(eq(schema.feedPosts.id, args.postId));
      const post = rows[0];
      if (!post) throw new Error("That post no longer exists.");
      // Resolve to the root original so credit always lands there.
      let root = post;
      if (post.repostOfId > 0) {
        const roots = await db.select().from(schema.feedPosts).where(eq(schema.feedPosts.id, post.repostOfId));
        if (roots[0]) root = roots[0];
      }
      if (root.flagged === 1) throw new Error("This post is under review and can't be reposted right now.");
      assertClean(args.comment);
      if (root.authorKey === args.playerKey) throw new Error("You can't repost your own post.");
      const existing = await db
        .select()
        .from(schema.feedReposts)
        .where(and(eq(schema.feedReposts.postId, root.id), eq(schema.feedReposts.playerKey, args.playerKey)));
      if (existing[0]) throw new Error("You've already reposted this.");
      const isQuote = args.comment.length > 0;
      const res = await db
        .insert(schema.feedPosts)
        .values({
          authorKey: args.playerKey,
          author: args.gamertag,
          kind: root.kind,
          title: root.title,
          // Quote Repost: the reposter's own comment is the body, and
          // the original renders below it from repostOfId. Simple
          // repost: the original's media is linked on the row itself.
          body: isQuote ? args.comment : "",
          mediaUrl: isQuote ? "" : root.mediaUrl,
          auto: root.auto,
          sourceName: root.sourceName,
          sourceUrl: root.sourceUrl,
          repostOfId: root.id,
        })
        .returning({ id: schema.feedPosts.id });
      const repostId = res[0]?.id ?? 0;
      await db.insert(schema.feedReposts).values({
        postId: root.id,
        playerKey: args.playerKey,
        repostPostId: repostId,
      });
      // Notify the original poster (real community members only —
      // automatic and example posts have no inbox).
      const authorProfile = await profilesByKey(ctx).then((m) => m.get(root.authorKey));
      if (
        root.authorKey !== FEED_AUTO_KEY &&
        root.authorKey !== FEED_EXAMPLE_KEY &&
        root.authorKey !== args.playerKey &&
        authorProfile?.notifyReposts !== 0
      ) {
        await db.insert(schema.notifications).values({
          playerKey: root.authorKey,
          actorGamertag: args.gamertag,
          kind: isQuote ? "Quote Repost" : "Repost",
          postId: root.id,
          repostPostId: repostId,
          postTitle: root.title || root.body.slice(0, 80),
        });
      }
      ctx.invalidateQueries();
      return { id: repostId };
    },
  }),

  repostChatMessage: defineAction({
    description: "Reposts a chat message (DM, group, crew or event chat) to the reposter's Feed as their own post, quoting the message and crediting its original author and the chat it came from. Signed-in accounts only.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().min(2).max(32),
      authorGamertag: z.string().trim().min(1).max(40),
      body: z.string().trim().min(1).max(2000),
      sourceLabel: z.string().trim().min(1).max(60),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      assertClean(args.body);
      const res = await db
        .insert(schema.feedPosts)
        .values({
          authorKey: args.playerKey,
          author: args.gamertag,
          kind: "Discussion",
          title: "",
          body: `"${args.body}"\n— ${args.authorGamertag}, reposted from ${args.sourceLabel}`,
          mediaUrl: "",
          sourceName: "ViceSunshine chat",
          sourceUrl: "",
        })
        .returning({ id: schema.feedPosts.id });
      ctx.invalidateQueries();
      return { id: res[0]?.id ?? 0 };
    },
  }),

  shareExternalPost: defineAction({
    description: "Shares a GTA post from outside ViceSunshine (YouTube, X, Rockstar Newswire, a creator's page) into the Feed by link: the original plays/links in the Feed, credited to the original creator / source and labelled Shared from [source]. Nothing is downloaded or re-uploaded.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().min(2).max(32),
      url: z.string().trim().min(8).max(500),
      comment: z.string().trim().max(500).default(""),
      kind: z
        .enum([
          "Post", "Screenshot", "Clip", "Funny", "Meme", "Streamer Clip",
          "Tutorial", "Gameplay", "Car Meet", "News", "Discussion",
          "Easter Egg Find", "Question", "News Discussion",
        ])
        .default("Clip"),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let parsed: URL;
      try {
        parsed = new URL(args.url);
      } catch {
        throw new Error("That doesn't look like a valid link. Paste the full URL of the post or video.");
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("Only web links (http/https) can be shared.");
      }
      if (/download|apk|crack|mod menu|free gta/i.test(args.url) || /download|apk|crack/i.test(args.comment)) {
        throw new Error("Links to downloads, mods or leaked footage are not allowed here.");
      }
      const host = parsed.hostname.replace(/^www\./, "");
      const sourceName =
        host === "youtube.com" || host === "youtu.be" || host === "m.youtube.com"
          ? "YouTube"
          : host === "x.com" || host === "twitter.com"
            ? "X"
            : host === "rockstargames.com"
              ? "Rockstar Newswire"
              : host;
      const res = await db
        .insert(schema.feedPosts)
        .values({
          authorKey: args.playerKey,
          author: args.gamertag,
          kind: args.kind,
          title: "",
          body:
            args.comment ||
            `Shared from ${sourceName} — the original plays here where the source allows it, and the creator keeps the credit and the view.`,
          mediaUrl: args.url,
          auto: 0,
          sourceName,
          sourceUrl: args.url,
        })
        .returning({ id: schema.feedPosts.id });
      ctx.invalidateQueries();
      return { id: res[0]?.id ?? 0 };
    },
  }),

  listNotifications: defineAction({
    description: "Lists the player's in-app notifications (newest first) with the unread count.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({
      unread: z.number(),
      items: z.array(
        z.object({
          id: z.number(),
          actorGamertag: z.string(),
          kind: z.string(),
          postTitle: z.string(),
          read: z.boolean(),
          createdAt: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.playerKey, args.playerKey))
        .orderBy(desc(schema.notifications.id));
      return {
        unread: rows.filter((r) => r.read === 0).length,
        items: rows.slice(0, 30).map((r) => ({
          id: r.id,
          actorGamertag: r.actorGamertag,
          kind: r.kind,
          postTitle: r.postTitle,
          read: r.read === 1,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  listActivityNotifications: defineAction({
    description: "Instagram-style activity list for the Feed / Clips top bar (owner's direction): everything about YOU, newest first — who started following you (from the signed follow events), who liked your story, who liked or commented on or reposted your Feed posts. Built only from real stored rows; actors are real profiles with their avatars. Empty for guests / brand-new accounts.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({
      items: z.array(
        z.object({
          id: z.string(),
          kind: z.enum(["follow", "story_like", "post_like", "comment", "repost"]),
          actorKey: z.string(),
          actor: z.string(),
          avatarUrl: z.string(),
          detail: z.string(),
          createdAt: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profileMap = await profilesByKey(ctx);
      if (!profileMap.has(args.playerKey)) return { items: [] };
      const artUrls = await avatarArtUrls(ctx);
      const customArt = await customAvatarUrls(ctx);
      const actorOf = (key: string) => {
        const p = profileMap.get(key);
        return {
          actor: p?.displayName?.trim() || p?.gamertag || "A player",
          avatarUrl: pickAvatar(artUrls, customArt, p),
        };
      };
      type Item = { id: string; kind: "follow" | "story_like" | "post_like" | "comment" | "repost"; actorKey: string; actor: string; avatarUrl: string; detail: string; createdAt: string };
      const items: Item[] = [];
      const followEvts = await db.select().from(schema.followEvents);
      for (const f of followEvts) {
        if (f.followingKey !== args.playerKey || f.action !== "follow" || f.followerKey === args.playerKey) continue;
        const a = actorOf(f.followerKey);
        items.push({ id: `follow-${f.id}`, kind: "follow", actorKey: f.followerKey, actor: a.actor, avatarUrl: a.avatarUrl, detail: "", createdAt: f.createdAt.toISOString() });
      }
      const myStories = (await db.select().from(schema.stories)).filter((s) => s.authorKey === args.playerKey);
      const myStoryIds = new Set(myStories.map((s) => s.id));
      const storyLikes = await db.select().from(schema.storyLikes);
      for (const l of storyLikes) {
        if (!myStoryIds.has(l.storyId) || l.playerKey === args.playerKey) continue;
        const a = actorOf(l.playerKey);
        items.push({ id: `storylike-${l.id}`, kind: "story_like", actorKey: l.playerKey, actor: a.actor, avatarUrl: a.avatarUrl, detail: "", createdAt: l.createdAt.toISOString() });
      }
      const myPosts = (await db.select().from(schema.feedPosts)).filter((p) => p.authorKey === args.playerKey);
      const myPostById = new Map(myPosts.map((p) => [p.id, p]));
      const reactions = await db.select().from(schema.feedReactions);
      for (const r of reactions) {
        const post = myPostById.get(r.postId);
        if (!post || r.playerKey === args.playerKey) continue;
        const a = actorOf(r.playerKey);
        items.push({ id: `postlike-${r.id}`, kind: "post_like", actorKey: r.playerKey, actor: a.actor, avatarUrl: a.avatarUrl, detail: post.title || post.body.slice(0, 60), createdAt: r.createdAt.toISOString() });
      }
      const comments = await db.select().from(schema.feedComments);
      for (const c of comments) {
        const post = myPostById.get(c.postId);
        if (!post || c.authorKey === args.playerKey) continue;
        const a = actorOf(c.authorKey);
        items.push({ id: `comment-${c.id}`, kind: "comment", actorKey: c.authorKey, actor: a.actor, avatarUrl: a.avatarUrl, detail: c.body.slice(0, 80), createdAt: c.createdAt.toISOString() });
      }
      const reposts = await db.select().from(schema.feedReposts);
      for (const r of reposts) {
        const post = myPostById.get(r.postId);
        if (!post || r.playerKey === args.playerKey) continue;
        const a = actorOf(r.playerKey);
        items.push({ id: `repost-${r.id}`, kind: "repost", actorKey: r.playerKey, actor: a.actor, avatarUrl: a.avatarUrl, detail: post.title || post.body.slice(0, 60), createdAt: r.createdAt.toISOString() });
      }
      items.sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0));
      return { items: items.slice(0, 30) };
    },
  }),

  markNotificationsRead: defineAction({
    description: "Marks all of the player's notifications as read.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.notifications)
        .set({ read: 1 })
        .where(eq(schema.notifications.playerKey, args.playerKey));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  createFeedPost: defineAction({
    description: "Publishes a post to the public community feed.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      author: z.string().trim().min(2).max(32),
      kind: z
        .enum([
          "Post", "Screenshot", "Clip", "Funny", "Meme", "Streamer Clip",
          "Tutorial", "Gameplay", "Car Meet", "News", "Discussion",
          "Easter Egg Find", "Question", "News Discussion",
        ])
        .default("Post"),
      title: z.string().trim().max(140).default(""),
      body: z.string().trim().min(1).max(2000),
      mediaUrl: z.string().trim().max(500).default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      assertClean(args.title, args.body);
      const mediaReason = screenMediaUrl(args.mediaUrl);
      if (mediaReason) {
        throw new Error(`Blocked by automatic moderation: ${mediaReason}.`);
      }
      // If the poster pasted a YouTube link into the text (or into the
      // media field), the video must play in the embedded player — the
      // raw URL never stays in the body as a "go watch it there" link.
      let mediaUrl = args.mediaUrl.trim();
      let body = args.body;
      if (!mediaUrl) {
        const found = body.match(YOUTUBE_URL_RE);
        if (found?.[0]) mediaUrl = found[0];
      }
      if (mediaUrl && youtubeIdOf(mediaUrl)) {
        body = stripVideoUrlsFromBody(body, mediaUrl);
        if (!body) body = "Shared a video — it plays right here in ViceSunshine, above.";
      }
      const res = await db
        .insert(schema.feedPosts)
        .values({
          authorKey: args.playerKey,
          author: args.author,
          kind: args.kind,
          title: args.title,
          body,
          mediaUrl,
        })
        .returning({ id: schema.feedPosts.id });
      // Publishing a Feed post earns +5 XP, counted automatically.
      const postId = res[0]?.id ?? 0;
      if (postId) {
        await recordPoints(ctx, {
          playerKey: args.playerKey,
          gamertag: args.author,
          targetClanId: null,
          points: POINT_RATES.feedPost,
          source: "feedpost",
          sourceRef: `feedpost:${postId}`,
          reason: "Posted in the Community Feed",
          verifiedBy: "ViceSunshine (in-app Feed post)",
        });
      }
      ctx.invalidateQueries();
      return { id: postId };
    },
  }),

  toggleFeedLike: defineAction({
    description: "Likes or unlikes a community feed post.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      postId: z.number().int().positive(),
    }),
    response: z.object({ liked: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      // Blocking works both ways: you cannot like or comment on a
      // post by someone you blocked, or someone who blocked you.
      const postForBlock = (await db.select().from(schema.feedPosts).where(eq(schema.feedPosts.id, args.postId)))[0];
      if (postForBlock && postForBlock.authorKey !== args.playerKey) {
        const authorBlocks = await blockedKeysFor(ctx, postForBlock.authorKey);
        if (authorBlocks.has(args.playerKey)) throw new Error("You can't interact with this post.");
        const myPostBlocks = await blockedKeysFor(ctx, args.playerKey);
        if (myPostBlocks.has(postForBlock.authorKey)) throw new Error("You've blocked this player — unblock them in Settings → Permissions to interact with their posts.");
      }
      const rows = await db
        .select()
        .from(schema.feedReactions)
        .where(
          and(
            eq(schema.feedReactions.postId, args.postId),
            eq(schema.feedReactions.playerKey, args.playerKey),
          ),
        );
      if (rows[0]) {
        await db.delete(schema.feedReactions).where(eq(schema.feedReactions.id, rows[0].id));
        ctx.invalidateQueries();
        return { liked: false };
      }
      await db.insert(schema.feedReactions).values({ postId: args.postId, playerKey: args.playerKey });
      // Feed points come only from real in-app likes, which ViceSunshine can
      // verify itself: when a post reaches 10 likes, its author earns
      // points once — subject to the daily cap on claim-based points.
      const posts = await db.select().from(schema.feedPosts).where(eq(schema.feedPosts.id, args.postId));
      const post = posts[0];
      if (post && post.authorKey !== args.playerKey) {
        const allReactions = await db
          .select()
          .from(schema.feedReactions)
          .where(eq(schema.feedReactions.postId, args.postId));
        if (allReactions.length >= 10) {
          await recordPoints(ctx, {
            playerKey: post.authorKey,
            gamertag: post.author,
            targetClanId: null,
            source: "feed",
            sourceRef: `feed:${post.id}`,
            reason: "Community Feed post reached 10 likes",
            points: POINT_RATES.feed,
            verifiedBy: "ViceSunshine (real in-app likes)",
          });
        }
      }
      ctx.invalidateQueries();
      return { liked: true };
    },
  }),

  listFeedComments: defineAction({
    description: "Lists comments on one community feed post for the Instagram-style comments sheet: avatar, username, time, like count / liked-by-me and threaded replies (parentId), oldest first.",
    request: z.object({
      postId: z.number().int().positive(),
      playerKey: z.string().max(80).default(""),
    }),
    response: z.object({
      items: z.array(
        z.object({
          id: z.number(),
          author: z.string(),
          authorAvatarUrl: z.string(),
          body: z.string(),
          parentId: z.number(),
          likes: z.number(),
          likedByMe: z.boolean(),
          createdAt: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.feedComments)
        .where(eq(schema.feedComments.postId, args.postId))
        .orderBy(asc(schema.feedComments.id));
      const reactions = await db.select().from(schema.feedCommentReactions);
      const profileMap = await profilesByKey(ctx);
      const artUrls = await avatarArtUrls(ctx);
      const customArt = await customAvatarUrls(ctx);
      return {
        items: rows.map((r) => ({
          id: r.id,
          author: r.author,
          authorAvatarUrl: pickAvatar(artUrls, customArt, profileMap.get(r.authorKey)),
          body: r.body,
          parentId: r.parentId ?? 0,
          likes: reactions.filter((x) => x.commentId === r.id).length,
          likedByMe: Boolean(args.playerKey) && reactions.some((x) => x.commentId === r.id && x.playerKey === args.playerKey),
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  addFeedComment: defineAction({
    description: "Adds a comment to a community feed post, or a threaded reply to one of its comments when parentId is set.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      postId: z.number().int().positive(),
      author: z.string().trim().min(2).max(32),
      body: z.string().trim().min(1).max(1000),
      parentId: z.number().int().min(0).default(0),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      // Blocking works both ways: you cannot like or comment on a
      // post by someone you blocked, or someone who blocked you.
      const postForBlock = (await db.select().from(schema.feedPosts).where(eq(schema.feedPosts.id, args.postId)))[0];
      if (postForBlock && postForBlock.authorKey !== args.playerKey) {
        const authorBlocks = await blockedKeysFor(ctx, postForBlock.authorKey);
        if (authorBlocks.has(args.playerKey)) throw new Error("You can't interact with this post.");
        const myPostBlocks = await blockedKeysFor(ctx, args.playerKey);
        if (myPostBlocks.has(postForBlock.authorKey)) throw new Error("You've blocked this player — unblock them in Settings → Permissions to interact with their posts.");
      }
      assertClean(args.body);
      let parentId = 0;
      if (args.parentId > 0) {
        const parents = await db
          .select()
          .from(schema.feedComments)
          .where(eq(schema.feedComments.id, args.parentId));
        const parent = parents[0];
        if (!parent || parent.postId !== args.postId) throw new Error("That comment could not be found on this post.");
        // Replies nest one level deep, Instagram-style: a reply to a
        // reply attaches to the top-level comment.
        parentId = parent.parentId > 0 ? parent.parentId : parent.id;
      }
      const res = await db
        .insert(schema.feedComments)
        .values({ postId: args.postId, authorKey: args.playerKey, author: args.author, body: args.body, parentId })
        .returning({ id: schema.feedComments.id });
      ctx.invalidateQueries();
      return { id: res[0]?.id ?? 0 };
    },
  }),

  toggleFeedCommentLike: defineAction({
    description: "Likes or unlikes one Feed comment (the heart in the comments sheet).",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      commentId: z.number().int().positive(),
    }),
    response: z.object({ liked: z.boolean(), likes: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      const existing = await db
        .select()
        .from(schema.feedCommentReactions)
        .where(
          and(
            eq(schema.feedCommentReactions.commentId, args.commentId),
            eq(schema.feedCommentReactions.playerKey, args.playerKey),
          ),
        );
      let liked: boolean;
      if (existing[0]) {
        await db
          .delete(schema.feedCommentReactions)
          .where(eq(schema.feedCommentReactions.id, existing[0].id));
        liked = false;
      } else {
        await db.insert(schema.feedCommentReactions).values({ commentId: args.commentId, playerKey: args.playerKey });
        liked = true;
      }
      const all = await db
        .select()
        .from(schema.feedCommentReactions)
        .where(eq(schema.feedCommentReactions.commentId, args.commentId));
      ctx.invalidateQueries();
      return { liked, likes: all.length };
    },
  }),

  recordFeedViews: defineAction({
    description: "Records that this player actually saw these Feed / Clips posts (one view per player per post, counted when a post is on screen) and returns the true distinct-viewer counts.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      postIds: z.array(z.number().int().positive()).min(1).max(30),
    }),
    response: z.object({
      items: z.array(z.object({ postId: z.number(), views: z.number() })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      // Views count as participation: only a real account's views
      // are recorded. A guest key still gets the current counts back
      // so the UI can display them — it just adds nothing.
      const profileRows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const existing = await db
        .select()
        .from(schema.feedViews)
        .where(eq(schema.feedViews.playerKey, args.playerKey));
      const seen = new Set(existing.map((v) => v.postId));
      const fresh = profileRows[0] ? [...new Set(args.postIds)].filter((id) => !seen.has(id)) : [];
      for (const postId of fresh) {
        await db.insert(schema.feedViews).values({ postId, playerKey: args.playerKey });
      }
      if (fresh.length > 0) ctx.invalidateQueries();
      const all = await db.select().from(schema.feedViews);
      return {
        items: [...new Set(args.postIds)].map((postId) => ({
          postId,
          views: all.filter((v) => v.postId === postId).length,
        })),
      };
    },
  }),

  listStories: defineAction({
    description: "Lists Instagram-style Stories for the Feed Stories row, grouped by author: only stories posted in the last 24 hours (older stories have disappeared), with per-story likes and seen state for this player. View counts are private to the poster, Instagram-style: a story's views number is only ever filled in on the author's own stories — everyone else's stories return 0 views here, and who viewed a story is only ever returned by getStoryInsights to the author themself. A private account's stories are only returned to players who follow that account (isPrivate flags the account on each group and person, so the row can show the lock and send a tap to the locked profile instead of a story). Groups are ordered for the row: people the player follows FIRST (flagged followedByMe), then unseen, then most recent — the client puts 'Your story' ahead of all of them.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({
      groups: z.array(
        z.object({
          authorKey: z.string(),
          author: z.string(),
          avatarUrl: z.string(),
          mine: z.boolean(),
          followedByMe: z.boolean(),
          isPrivate: z.boolean(),
          hasUnseen: z.boolean(),
          latestAt: z.string(),
          stories: z.array(
            z.object({
              id: z.number(),
              mediaUrl: z.string(),
              mediaType: z.string(),
              text: z.string(),
              sticker: z.string(),
              createdAt: z.string(),
              expiresAt: z.string(),
              views: z.number(),
              likes: z.number(),
              likedByMe: z.boolean(),
              mine: z.boolean(),
            }),
          ),
        }),
      ),
      people: z.array(
        z.object({
          playerKey: z.string(),
          name: z.string(),
          gamertag: z.string(),
          avatarUrl: z.string(),
          followedByMe: z.boolean(),
          isPrivate: z.boolean(),
          recommended: z.boolean(),
          hasStory: z.boolean(),
          hasUnseen: z.boolean(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      let rows = (await db.select().from(schema.stories).orderBy(asc(schema.stories.id))).filter(
        (r) => r.createdAt.getTime() > cutoff,
      );
      // Privacy: stories never reach players the author hid them
      // from, players the author blocked, or players who blocked the
      // author. My own stories always show to me.
      const storyBlockedSet = await blockedKeysFor(ctx, args.playerKey);
      const storyBlockedBySet = await blockedByKeysFor(ctx, args.playerKey);
      const hiddenFromRows = await db.select().from(schema.storyHiddenFrom);
      const hiddenFromMap = new Map<string, Set<string>>();
      for (const h of hiddenFromRows) {
        const s = hiddenFromMap.get(h.playerKey) ?? new Set<string>();
        s.add(h.hiddenKey);
        hiddenFromMap.set(h.playerKey, s);
      }
      rows = rows.filter(
        (r) =>
          r.authorKey === args.playerKey ||
          (!storyBlockedSet.has(r.authorKey) &&
            !storyBlockedBySet.has(r.authorKey) &&
            !(hiddenFromMap.get(r.authorKey)?.has(args.playerKey) ?? false)),
      );
      const viewRows = await db.select().from(schema.storyViews);
      const likeRows = await db.select().from(schema.storyLikes);
      const followRows = await db.select().from(schema.profileFollows);
      const myFollowing = new Set(followRows.filter((f) => f.followerKey === args.playerKey).map((f) => f.followingKey));
      const profileMap = await profilesByKey(ctx);
      const artUrls = await avatarArtUrls(ctx);
      const customArt = await customAvatarUrls(ctx);
      // Private accounts (owner's rule): a private account's
      // stories cannot be seen by the public — only by players the
      // account has accepted as followers (a profile_follows row).
      // A non-follower never receives the story at all here, so
      // tapping their circle in the row lands on their profile,
      // which shows the private / locked state instead of posts.
      // My own stories always show to me.
      rows = rows.filter(
        (r) =>
          r.authorKey === args.playerKey ||
          profileMap.get(r.authorKey)?.profilePrivate !== 1 ||
          myFollowing.has(r.authorKey),
      );
      const byAuthor = new Map<string, typeof rows>();
      for (const r of rows) byAuthor.set(r.authorKey, [...(byAuthor.get(r.authorKey) ?? []), r]);
      const groups = [...byAuthor.entries()].map(([authorKey, list]) => {
        const first = list[0];
        const stories = list.map((r) => ({
          id: r.id,
          mediaUrl: r.mediaUrl,
          mediaType: storyMediaTypeOf(r.mediaType, r.mediaUrl),
          text: r.text,
          sticker: r.sticker,
          createdAt: r.createdAt.toISOString(),
          expiresAt: new Date(r.createdAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
          // Views are the poster's private number (Instagram
          // rule): only the author's own stories carry it.
          views: authorKey === args.playerKey ? viewRows.filter((v) => v.storyId === r.id).length : 0,
          likes: likeRows.filter((v) => v.storyId === r.id).length,
          likedByMe: likeRows.some((v) => v.storyId === r.id && v.playerKey === args.playerKey),
          mine: authorKey === args.playerKey,
        }));
        return {
          authorKey,
          author: first?.author ?? "",
          avatarUrl: pickAvatar(artUrls, customArt, profileMap.get(authorKey)),
          mine: authorKey === args.playerKey,
          followedByMe: myFollowing.has(authorKey),
          isPrivate: profileMap.get(authorKey)?.profilePrivate === 1,
          hasUnseen:
            authorKey !== args.playerKey &&
            list.some((r) => !viewRows.some((v) => v.storyId === r.id && v.playerKey === args.playerKey)),
          latestAt: list[list.length - 1]?.createdAt.toISOString() ?? "",
          stories,
        };
      });
      // People the player follows first (owner's direction — their
      // stories sit right after "Your story" in the row), then
      // unseen, then most recent. My own group stays in the list
      // but the client renders it as "Your story".
      groups.sort(
        (a, b) =>
          Number(b.followedByMe) - Number(a.followedByMe) ||
          Number(b.hasUnseen) - Number(a.hasUnseen) ||
          (b.latestAt > a.latestAt ? 1 : b.latestAt < a.latestAt ? -1 : 0),
      );
      // The Stories row itself (owner's direction, Instagram-style):
      // one row of people circles — everyone the player FOLLOWS first,
      // then RECOMMENDED people — whether or not they have a live
      // story right now. hasStory / hasUnseen say which circles carry
      // a story ring; the rest open the person's profile. Blocked
      // players (either way) never appear.
      const groupByKey = new Map(groups.map((g) => [g.authorKey, g]));
      const followersCount = new Map<string, number>();
      for (const f of followRows) followersCount.set(f.followingKey, (followersCount.get(f.followingKey) ?? 0) + 1);
      const secondDegree = new Set(followRows.filter((f) => myFollowing.has(f.followerKey)).map((f) => f.followingKey));
      const memberRows = await db.select().from(schema.clanMembers);
      const myClanIds = new Set(memberRows.filter((m) => m.playerKey === args.playerKey).map((m) => m.clanId));
      const crewMates = new Set(memberRows.filter((m) => m.playerKey !== args.playerKey && myClanIds.has(m.clanId)).map((m) => m.playerKey));
      type RowPerson = { playerKey: string; name: string; gamertag: string; avatarUrl: string; followedByMe: boolean; isPrivate: boolean; recommended: boolean; hasStory: boolean; hasUnseen: boolean; score: number };
      const rowPeople: RowPerson[] = [];
      for (const prof of profileMap.values()) {
        if (prof.playerKey === args.playerKey) continue;
        if (storyBlockedSet.has(prof.playerKey) || storyBlockedBySet.has(prof.playerKey)) continue;
        const g = groupByKey.get(prof.playerKey);
        const followed = myFollowing.has(prof.playerKey);
        let score = followersCount.get(prof.playerKey) ?? 0;
        if (crewMates.has(prof.playerKey)) score += 1000;
        if (secondDegree.has(prof.playerKey)) score += 500;
        rowPeople.push({
          playerKey: prof.playerKey,
          name: prof.displayName?.trim() || prof.gamertag,
          gamertag: prof.gamertag,
          avatarUrl: pickAvatar(artUrls, customArt, prof),
          followedByMe: followed,
          isPrivate: prof.profilePrivate === 1,
          recommended: !followed,
          hasStory: Boolean(g),
          hasUnseen: g?.hasUnseen ?? false,
          score,
        });
      }
      rowPeople.sort(
        (a, b) =>
          Number(b.followedByMe) - Number(a.followedByMe) ||
          Number(b.hasUnseen) - Number(a.hasUnseen) ||
          Number(b.hasStory) - Number(a.hasStory) ||
          b.score - a.score ||
          a.name.localeCompare(b.name),
      );
      const people = rowPeople.slice(0, 24).map(({ score: _score, ...rest }) => rest);
      return { groups, people };
    },
  }),

  createStory: defineAction({
    description: "Posts an Instagram-style Story (photo / video / clip link, or text-only) with an optional text overlay and sticker. The story disappears automatically 24 hours after posting.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      author: z.string().trim().min(2).max(32),
      mediaUrl: z.string().trim().max(2000).default(""),
      text: z.string().trim().max(140).default(""),
      sticker: z.string().trim().max(40).default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      if (!args.mediaUrl && !args.text) throw new Error("Add a photo, video or some text to your story first.");
      if (args.text) assertClean(args.text);
      if (args.sticker) assertClean(args.sticker);
      const media = feedMediaOf(args.mediaUrl);
      const mediaType = !args.mediaUrl
        ? "text"
        : media.mediaType === "image"
          ? "image"
          : media.mediaType === "video"
            ? "video"
            : media.mediaType === "youtube" || media.mediaType === "tiktok"
              ? "embed"
              : /\.(png|jpe?g|webp|gif)(\?|$)/i.test(args.mediaUrl)
                ? "image"
                : /\.(mp4|webm)(\?|$)/i.test(args.mediaUrl)
                  ? "video"
                  : "embed";
      const res = await db
        .insert(schema.stories)
        .values({
          authorKey: args.playerKey,
          author: args.author,
          mediaUrl: args.mediaUrl,
          mediaType,
          text: args.text,
          sticker: args.sticker,
        })
        .returning({ id: schema.stories.id });
      ctx.invalidateQueries();
      return { id: res[0]?.id ?? 0 };
    },
  }),

  viewStory: defineAction({
    description: "Records that this player viewed a story (once per player per story; the author never counts as their own viewer) and returns the story's true view count ONLY to the story's author — views are the poster's private number, so anyone else gets 0 back.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().max(32).default(""),
      storyId: z.number().int().positive(),
    }),
    response: z.object({ views: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.stories).where(eq(schema.stories.id, args.storyId));
      const story = rows[0];
      if (!story) throw new Error("That story has disappeared.");
      if (story.authorKey !== args.playerKey) {
        const hiddenFromAuthor = await storyHiddenKeysFor(ctx, story.authorKey);
        if (hiddenFromAuthor.has(args.playerKey)) throw new Error("That story isn't available to you.");
        const authorBlocksViewer = await blockedKeysFor(ctx, story.authorKey);
        if (authorBlocksViewer.has(args.playerKey)) throw new Error("That story isn't available to you.");
      }
      if (story.authorKey !== args.playerKey) {
        const existing = await db
          .select()
          .from(schema.storyViews)
          .where(
            and(eq(schema.storyViews.storyId, args.storyId), eq(schema.storyViews.playerKey, args.playerKey)),
          );
        if (!existing[0]) {
          await db.insert(schema.storyViews).values({
            storyId: args.storyId,
            playerKey: args.playerKey,
            viewerGamertag: args.gamertag,
          });
          ctx.invalidateQueries();
        }
      }
      const all = await db
        .select()
        .from(schema.storyViews)
        .where(eq(schema.storyViews.storyId, args.storyId));
      // Only the poster ever sees the count (Instagram rule).
      return { views: story.authorKey === args.playerKey ? all.length : 0 };
    },
  }),

  toggleStoryLike: defineAction({
    description: "Likes or unlikes a story from the story viewer's heart button.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      storyId: z.number().int().positive(),
    }),
    response: z.object({ liked: z.boolean(), likes: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      const storyForPrivacy = (await db.select().from(schema.stories).where(eq(schema.stories.id, args.storyId)))[0];
      if (storyForPrivacy && storyForPrivacy.authorKey !== args.playerKey) {
        const hiddenFromAuthor2 = await storyHiddenKeysFor(ctx, storyForPrivacy.authorKey);
        if (hiddenFromAuthor2.has(args.playerKey)) throw new Error("That story isn't available to you.");
        const authorBlocksViewer2 = await blockedKeysFor(ctx, storyForPrivacy.authorKey);
        if (authorBlocksViewer2.has(args.playerKey)) throw new Error("That story isn't available to you.");
      }
      const existing = await db
        .select()
        .from(schema.storyLikes)
        .where(
          and(eq(schema.storyLikes.storyId, args.storyId), eq(schema.storyLikes.playerKey, args.playerKey)),
        );
      let liked: boolean;
      if (existing[0]) {
        await db.delete(schema.storyLikes).where(eq(schema.storyLikes.id, existing[0].id));
        liked = false;
      } else {
        await db.insert(schema.storyLikes).values({ storyId: args.storyId, playerKey: args.playerKey });
        liked = true;
      }
      const all = await db
        .select()
        .from(schema.storyLikes)
        .where(eq(schema.storyLikes.storyId, args.storyId));
      ctx.invalidateQueries();
      return { liked, likes: all.length };
    },
  }),

  replyToStory: defineAction({
    description: "Sends a reply to a story; the poster reads story replies in their story insights (viewers list).",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      author: z.string().trim().min(2).max(32),
      storyId: z.number().int().positive(),
      body: z.string().trim().min(1).max(500),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      const storyForPrivacy = (await db.select().from(schema.stories).where(eq(schema.stories.id, args.storyId)))[0];
      if (storyForPrivacy && storyForPrivacy.authorKey !== args.playerKey) {
        const hiddenFromAuthor2 = await storyHiddenKeysFor(ctx, storyForPrivacy.authorKey);
        if (hiddenFromAuthor2.has(args.playerKey)) throw new Error("That story isn't available to you.");
        const authorBlocksViewer2 = await blockedKeysFor(ctx, storyForPrivacy.authorKey);
        if (authorBlocksViewer2.has(args.playerKey)) throw new Error("That story isn't available to you.");
      }
      assertClean(args.body);
      const rows = await db.select().from(schema.stories).where(eq(schema.stories.id, args.storyId));
      if (!rows[0]) throw new Error("That story has disappeared.");
      const res = await db
        .insert(schema.storyReplies)
        .values({ storyId: args.storyId, playerKey: args.playerKey, author: args.author, body: args.body })
        .returning({ id: schema.storyReplies.id });
      ctx.invalidateQueries();
      return { id: res[0]?.id ?? 0 };
    },
  }),

  getStoryPrivacy: defineAction({
    description: "Returns the player's Hide Story controls: the people their stories are currently hidden from, and the people they can pick from (players they follow, their followers, and their crewmates), each flagged hidden or not.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({
      hiddenFrom: z.array(z.object({ playerKey: z.string(), gamertag: z.string(), avatarUrl: z.string() })),
      people: z.array(z.object({ playerKey: z.string(), gamertag: z.string(), avatarUrl: z.string(), hidden: z.boolean() })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      const profileMap = await profilesByKey(ctx);
      const artUrls = await avatarArtUrls(ctx);
      const customArt = await customAvatarUrls(ctx);
      const hiddenSet = await storyHiddenKeysFor(ctx, args.playerKey);
      const follows = await db.select().from(schema.profileFollows);
      const peopleKeys = new Set<string>();
      for (const f of follows) {
        if (f.followerKey === args.playerKey) peopleKeys.add(f.followingKey);
        if (f.followingKey === args.playerKey) peopleKeys.add(f.followerKey);
      }
      const myMemberships = await db.select().from(schema.clanMembers).where(eq(schema.clanMembers.playerKey, args.playerKey));
      const myClanIds = new Set(myMemberships.map((m) => m.clanId));
      if (myClanIds.size > 0) {
        const mates = await db.select().from(schema.clanMembers);
        for (const m of mates) if (myClanIds.has(m.clanId)) peopleKeys.add(m.playerKey);
      }
      for (const k of hiddenSet) peopleKeys.add(k);
      peopleKeys.delete(args.playerKey);
      const person = (key: string) => {
        const p = profileMap.get(key);
        if (!p) return null;
        return { playerKey: key, gamertag: p.gamertag, avatarUrl: pickAvatar(artUrls, customArt, p) };
      };
      const hiddenFrom = [...hiddenSet].map(person).filter((x): x is NonNullable<typeof x> => x !== null);
      const people = [...peopleKeys]
        .map((key) => {
          const base = person(key);
          return base ? { ...base, hidden: hiddenSet.has(key) } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => a.gamertag.localeCompare(b.gamertag));
      return { hiddenFrom, people };
    },
  }),

  setStoryHiddenFrom: defineAction({
    description: "Hides (or un-hides) the player's stories from one specific player. Hidden players never see the author's stories and cannot view, like or reply to them. You cannot hide your story from yourself.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      targetKey: z.string().min(1).max(80),
      hidden: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true), hidden: z.boolean() }),
    async handler(ctx, args): Promise<{ ok: true; hidden: boolean }> {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      if (args.targetKey === args.playerKey) throw new Error("You can't hide your story from yourself.");
      const target = (await db.select().from(schema.profiles).where(eq(schema.profiles.playerKey, args.targetKey)))[0];
      if (!target) throw new Error("That player no longer has a profile.");
      const existing = await db
        .select()
        .from(schema.storyHiddenFrom)
        .where(and(eq(schema.storyHiddenFrom.playerKey, args.playerKey), eq(schema.storyHiddenFrom.hiddenKey, args.targetKey)));
      if (args.hidden && existing.length === 0) {
        await db.insert(schema.storyHiddenFrom).values({ playerKey: args.playerKey, hiddenKey: args.targetKey });
      }
      if (!args.hidden && existing[0]) {
        await db.delete(schema.storyHiddenFrom).where(eq(schema.storyHiddenFrom.id, existing[0].id));
      }
      ctx.invalidateQueries();
      return { ok: true, hidden: args.hidden };
    },
  }),

  getStoryInsights: defineAction({
    description: "The poster's story insights: who viewed their story (gamertag, avatar, time), the like count and the replies people sent — only ever returned to the story's own author.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      storyId: z.number().int().positive(),
    }),
    response: z.object({
      views: z.number(),
      likes: z.number(),
      viewers: z.array(
        z.object({ gamertag: z.string(), avatarUrl: z.string(), viewedAt: z.string() }),
      ),
      replies: z.array(
        z.object({ id: z.number(), author: z.string(), body: z.string(), createdAt: z.string() }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.stories).where(eq(schema.stories.id, args.storyId));
      const story = rows[0];
      if (!story || story.authorKey !== args.playerKey) {
        return { views: 0, likes: 0, viewers: [], replies: [] };
      }
      const viewRows = await db
        .select()
        .from(schema.storyViews)
        .where(eq(schema.storyViews.storyId, args.storyId))
        .orderBy(desc(schema.storyViews.id));
      const likeRows = await db
        .select()
        .from(schema.storyLikes)
        .where(eq(schema.storyLikes.storyId, args.storyId));
      const replyRows = await db
        .select()
        .from(schema.storyReplies)
        .where(eq(schema.storyReplies.storyId, args.storyId))
        .orderBy(asc(schema.storyReplies.id));
      const profileMap = await profilesByKey(ctx);
      const artUrls = await avatarArtUrls(ctx);
      const customArt = await customAvatarUrls(ctx);
      return {
        views: viewRows.length,
        likes: likeRows.length,
        viewers: viewRows.map((v) => ({
          gamertag: v.viewerGamertag || profileMap.get(v.playerKey)?.gamertag || "Player",
          avatarUrl: pickAvatar(artUrls, customArt, profileMap.get(v.playerKey)),
          viewedAt: v.createdAt.toISOString(),
        })),
        replies: replyRows.map((r) => ({
          id: r.id,
          author: r.author,
          body: r.body,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  shareFeedPost: defineAction({
    description: "Records a share of a community feed post. Signed-in accounts only.",
    request: z.object({
      postId: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      const rows = await db.select().from(schema.feedPosts).where(eq(schema.feedPosts.id, args.postId));
      const row = rows[0];
      if (!row) throw new Error("Post not found.");
      await db
        .update(schema.feedPosts)
        .set({ shares: row.shares + 1 })
        .where(eq(schema.feedPosts.id, args.postId));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  reportFeedPost: defineAction({
    description: "Reports a feed post; three reports flag it for moderator review.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      postId: z.number().int().positive(),
      reason: z.string().trim().max(300).default(""),
    }),
    response: z.object({ reports: z.number(), flagged: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.feedReports)
        .where(
          and(
            eq(schema.feedReports.postId, args.postId),
            eq(schema.feedReports.reporterKey, args.playerKey),
          ),
        );
      if (!existing[0]) {
        await db.insert(schema.feedReports).values({
          postId: args.postId,
          reporterKey: args.playerKey,
          reason: args.reason,
        });
      }
      const all = await db
        .select()
        .from(schema.feedReports)
        .where(eq(schema.feedReports.postId, args.postId));
      const flagged = all.length >= 3;
      if (flagged) {
        await db.update(schema.feedPosts).set({ flagged: 1 }).where(eq(schema.feedPosts.id, args.postId));
      }
      ctx.invalidateQueries();
      return { reports: all.length, flagged };
    },
  }),

  reportPlayer: defineAction({
    description: "Reports another player to moderation review — the standard report flow: a reason from the standard list (Spam, Harassment, Hate speech, Illegal content, False information, Bad name, Bad words, Breaking the rules, Something else) plus an optional short detail. One report per reporter per player; reports land in the owner dashboard's moderation queue, and the reported player is never told who reported them.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      reportedKey: z.string().min(1).max(80),
      reason: z.enum(["Spam", "Harassment", "Hate speech", "Illegal content", "False information", "Bad name", "Bad words", "Breaking the rules", "Something else"]),
      details: z.string().trim().max(300).default(""),
    }),
    response: z.object({ reports: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (args.reportedKey === args.playerKey) throw new Error("You can't report yourself.");
      const profs = await db.select().from(schema.profiles);
      if (!profs.some((p) => p.playerKey === args.playerKey)) throw new Error("Create your profile first — reporting only works when you're signed in.");
      if (!profs.some((p) => p.playerKey === args.reportedKey)) throw new Error("That player no longer has a profile.");
      if (args.details) assertClean(args.details);
      const existing = await db
        .select()
        .from(schema.playerReports)
        .where(
          and(
            eq(schema.playerReports.reporterKey, args.playerKey),
            eq(schema.playerReports.reportedKey, args.reportedKey),
          ),
        );
      if (!existing[0]) {
        await db.insert(schema.playerReports).values({
          reporterKey: args.playerKey,
          reportedKey: args.reportedKey,
          reason: args.reason,
          details: args.details,
        });
      }
      const all = await db
        .select()
        .from(schema.playerReports)
        .where(eq(schema.playerReports.reportedKey, args.reportedKey));
      ctx.invalidateQueries();
      return { reports: all.length };
    },
  }),

  hideFeedPost: defineAction({
    description: "Hides a feed post for this player only.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      postId: z.number().int().positive(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.feedHidden)
        .where(
          and(
            eq(schema.feedHidden.postId, args.postId),
            eq(schema.feedHidden.playerKey, args.playerKey),
          ),
        );
      if (!existing[0]) {
        await db.insert(schema.feedHidden).values({ postId: args.postId, playerKey: args.playerKey });
      }
      ctx.invalidateQueries();
      return ok();
    },
  }),

  deleteFeedPost: defineAction({
    description: "Deletes the player's own feed post, or any flagged post when moderating.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      postId: z.number().int().positive(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.feedPosts).where(eq(schema.feedPosts.id, args.postId));
      const row = rows[0];
      if (!row) throw new Error("Post not found.");
      if (row.authorKey !== args.playerKey && row.flagged !== 1) {
        throw new Error("You can only delete your own posts — or a post flagged by 3+ reports.");
      }
      await db.delete(schema.feedPosts).where(eq(schema.feedPosts.id, args.postId));
      await db.delete(schema.feedComments).where(eq(schema.feedComments.postId, args.postId));
      await db.delete(schema.feedReactions).where(eq(schema.feedReactions.postId, args.postId));
      ctx.invalidateQueries();
      return ok();
    },
  }),
  uploadFeedMedia: defineAction({
    description: "Uploads a short clip or image for a Community Feed post. Limits: images up to 4 MB; video (MP4/WebM) up to 12 MB and 60 seconds (length checked in the composer before upload). Returns the stored media URL.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      filename: z.string().trim().min(1).max(120),
      mimeType: z.string().min(3).max(60),
      dataBase64: z.string().min(10).max(17000000),
    }),
    response: z.object({ url: z.string() }),
    async handler(ctx, args) {
      const imageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
      const videoTypes = ["video/mp4", "video/webm"];
      const isImage = imageTypes.includes(args.mimeType);
      const isVideo = videoTypes.includes(args.mimeType);
      if (!isImage && !isVideo) {
        throw new Error("Only images (PNG, JPG, WebP, GIF) or short videos (MP4, WebM) can be uploaded.");
      }
      const bytes = Buffer.from(args.dataBase64, "base64");
      const limit = isImage ? 4 * 1024 * 1024 : 12 * 1024 * 1024;
      if (bytes.length > limit) {
        throw new Error(
          isImage
            ? "That image is over the 4 MB limit — please compress it and try again."
            : "That clip is over the 12 MB limit — please trim it to 60 seconds or less and try again.",
        );
      }
      // Automatic image moderation: JPEG / PNG uploads are checked
      // by the moderation model BEFORE they are stored — nudity or
      // sexual content, anything sexualising a minor, graphic
      // real-world violence, real-world illegal trade and scam /
      // leak / piracy adverts are rejected and never stored. WebP /
      // GIF images and videos cannot be read by the checker; posts
      // using them are still covered by text screening at posting
      // time, the report system, the hourly sweep and the owner's
      // moderation queue.
      if (args.mimeType === "image/jpeg" || args.mimeType === "image/png") {
        await assertImageAllowed(ctx, args.dataBase64, args.mimeType, args.filename, "image");
      }
      const safeName = args.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
      const key = `feed/${args.playerKey}/${Date.now()}-${safeName}`;
      await ctx.blobs.put(key, bytes, { contentType: args.mimeType });
      const url = await ctx.blobs.getUrl(key);
      ctx.invalidateQueries();
      return { url };
    },
  }),

  askVice: defineAction({
    description: "Ask Vice, the ViceSunshine AI helper and website guide. Answers ONLY when asked, from ViceSunshine's own public content (latest News, Guides, Database, public Events, Easter Eggs, Bugs, public Crews, public Feed posts, patches), step-by-step how-to guides for every page and tool, the app's real rules, and the signed-in player's OWN account line. Privacy is structural: no other player's private data (email, payment, messages, saved items, account details) is ever loaded into the context, private events and lobby details are excluded, and the prompt hard-refuses requests for other people's private information. Never invents GTA VI facts; flags when a human needs to review (support request).",
    request: z.object({
      question: z.string().min(2).max(600),
      playerKey: z.string().max(80).default(""),
      gamertag: z.string().max(60).default(""),
      history: z.array(z.object({ role: z.enum(["user", "vice"]), text: z.string().max(1200) })).max(8).default([]),
    }),
    response: z.object({
      answer: z.string(),
      links: z.array(z.object({ label: z.string(), tab: z.string(), url: z.string() })),
      needsHuman: z.boolean(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const q = args.question.toLowerCase();
      const words = [...new Set(q.split(/[^a-z0-9]+/).filter((w) => w.length > 2))];
      const score = (text: string): number => words.reduce((acc, w) => acc + (text.toLowerCase().includes(w) ? 1 : 0), 0);
      const pick = <T,>(rows: T[], text: (r: T) => string, n: number): T[] =>
        rows.map((r) => ({ r, sc: score(text(r)) })).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, n).map((x) => x.r);

      const [newsRows, guideRows, dbRows, eventRows, patchRows, eggRows, bugRows, clanRows, feedRows] = await Promise.all([
        db.select().from(schema.news),
        db.select().from(schema.guides),
        db.select().from(schema.dbEntries),
        db.select().from(schema.events),
        db.select().from(schema.patches),
        db.select().from(schema.eggs),
        db.select().from(schema.bugs),
        db.select().from(schema.clans),
        db.select().from(schema.feedPosts),
      ]);
      const news = pick(newsRows, (r) => `${r.title} ${r.summary}`, 3);
      const guides = pick(guideRows, (r) => `${r.title} ${r.body}`, 2);
      const entries = pick(dbRows, (r) => `${r.name} ${r.category} ${r.description}`, 3);
      // PUBLIC events only — private events, their hosts' lobby
      // details and invite codes are other players' private
      // information and are never loaded here.
      const publicEvents = eventRows.filter((e) => e.visibility === "Public");
      const events = pick(publicEvents, (r) => `${r.title} ${r.type} ${r.description}`, 3);
      const eggs = pick(eggRows, (r) => `${r.name} ${r.location} ${r.howTo}`, 2);
      const bugs = pick(bugRows, (r) => `${r.title} ${r.description}`, 2);
      // Public crew directory fields only (name, tag, platform,
      // motto) — never member lists or any member's details.
      const crews = pick(clanRows, (r) => `${r.name} ${r.tag} ${r.motto} ${r.description}`, 2);
      const latestPatch = [...patchRows].sort((a, b) => b.id - a.id)[0];
      // Always-on latest content, so "what's today's news" and
      // "what's trending" questions have real material even when no
      // keyword matches: the 3 newest news stories and the 3 newest
      // public Feed posts.
      const latestNews = [...newsRows].sort((a, b) => b.id - a.id).slice(0, 3);
      const latestFeed = [...feedRows].filter((p) => p.flagged !== 1).sort((a, b) => b.id - a.id).slice(0, 3);

      let account = "The player has not set up a profile yet (no wallet details available).";
      if (args.playerKey) {
        const profRows = await db.select().from(schema.profiles).where(eq(schema.profiles.playerKey, args.playerKey));
        const prof = profRows[0];
        if (prof) {
          const memberships = await db.select().from(schema.clanMembers).where(eq(schema.clanMembers.playerKey, args.playerKey));
          account = `Signed-in player: gamertag ${prof.gamertag}, platform ${prof.platform}, Vice Credits balance ${prof.credits}, Premium ${prof.premium === 1 ? "active" : "not active"}, member of ${memberships.length} crew(s)${memberships.length ? ` (${memberships.map((m) => m.role).join(", ")})` : ""}.`;
        }
      }

      const context = [
        "HOW VICESUNSHINE WORKS (state these facts exactly when relevant):",
        "- Vice Credits: every new account starts with 500. Creating a crew costs 500 from the creator's personal wallet. Rank Points earned in-app pay 1 Vice Credit each, plus a +2 crew XP boost bonus when a crew benefits.",
        "- XP and Rank Points are the same automatic count (in-app activity only — no uploads, no proof queue): RSVP Going to a community event +15; post in the Community Feed +5; a Feed post reaching 10 real likes +10; recruit (a member joining — joining a crew counts) +15; crew feed post +2 (max 10/day); host-confirmed event win +50/+30/+20 for 1st/2nd/3rd; moderator-confirmed bug +20; moderator-verified Easter egg +25. XP raises the ViceSunshine level: Level 2 at 200 XP, Level 3 at 500, Level 4 at 1,000, Level 5 at 2,000, then widening steps.",
        "- Season Challenges (the Challenges page): every season (calendar month; Season 1 = November 2026) has web-based-only challenges counted automatically from the player's own ViceSunshine profile — RSVP Going to events, make Feed posts, get likes on Feed posts, members recruited into your crew, and reaching a ViceSunshine Level. Targets rise every season (events 5 in Season 1, 10 in Season 2, 15 in Season 3; the level challenge climbs to Level 10, then Level 20 and beyond). Completing a challenge unlocks its calling card automatically — no claim step. Each season's calling cards are AUTO-GENERATED fresh for that season (original ViceSunshine art in the COD-card style Ben loves — dark cards, skulls, neon-green leaves, fire, smoke) at a higher design tier every season, so every season's set is better than the last; unlocked cards stay owned and equippable forever, and a season card is also the profile banner when equipped.",
        "- ViceSunshine levels & milestone rewards: Rank Points raise your ViceSunshine level (a community level from in-app activity only — never an in-game GTA VI level, and ViceSunshine never asks anyone to report one). Reaching a milestone level pays Vice Credits once, automatically: Level 5 +100, 10 +250, 15 +400, 20 +600, 25 +800, 30 +1,000, 40 +1,500, 50 +2,500. Mission statement: Play GTA VI. Level up in ViceSunshine. Earn rewards here.",
        "- Community Events: hosted by crew Leaders — only a Leader can create an event, and only when their crew has at least 10 members. Events are Public (anyone can see and join) or Private (invite-only — hidden from the list; only the host crew's members can see them, plus anyone the host invites with the event's invite link (#event=CODE) or 6-character invite code, entered on the Events page under 'Joining a private event?'). Players find events on the Events page by searching the event name or a hashtag like #carmeet, #race, #timetrial or #screenshot, or by tapping the hashtag chips and filters (type, platform, Public / Private). There are no Crew Wars in ViceSunshine anymore — Community Events replaced them.",
        "- Seasons: calendar months. Rankings (Global / Local / PlayStation / Xbox) sort by this month's Rank Points and reset each month; lifetime Crew Level and credits never reset. Season prizes per board: 1st 1,000 crew credits, 2nd 600, 3rd 300, ranks 4-10 get 100 — plus the Phoenix emblem for 1st, which is a Crew Award (see below), not credits.",
        "- Crew Awards — earned, never for sale: when a crew hits a milestone together — 10 members, or finishing a season ranked #1 — the WHOLE crew earns an exclusive reward (Founders banner style, Phoenix emblem). Crew Awards are never for sale — not for Vice Credits and not for real money and cannot be owned individually; they show on the crew card and crew home, and a Leader / Co-Leader equips them from the Crew Awards section on the crew page.",
        "- Event Rewards — Vice Credits for the winning crew: separate from Crew Awards. Community events pay the 1st-place player's crew 150 credits (2nd 75, 3rd 50) and +10 participation credits to every other crew that showed up, once the host confirms results. Season finishes also pay credits per board (1st 1,000, 2nd 600, 3rd 300, ranks 4-10 get 100).",
        "- Joining a crew: +50 Vice Credits welcome bonus (once per crew), crew chat/feed, squads, crew events, and the XP boost.",
        "- Customisation is FREE and there is no Shop: every Customise section holds exactly 5 free items and 3 Premium items — no more. The sections are Avatars, Avatar Effects, Badges, Calling Cards / Banners, Themes, Crew Emblems, Crew Colours and Crew Calling Cards / Banners. There is NO banner colour picker and no separate banner section: the Calling Card IS the profile banner (and the crew calling card is the crew banner) — one merged thing. There are no avatar frames and no name colours — every name in ViceSunshine is shown in white only. Free items (avatars, effects, badges, calling cards, themes, crew emblems and crew colours) are picked and equipped for free, instantly, in the Customise section. Premium members ALSO get the 3 Premium items in each section, included with Premium and never sold separately — free members cannot use them: 3 Premium avatars (Neon Outlaw, Alien Visitor, Supercar Ace), 3 Premium avatar effects (Inferno Mohawk — animated flames rooted in the top of the avatar circle; Storm Helmet — a metal helmet dome worn by the avatar with a lightning crest; Dragon Horns — big curved horns rooted into the circle; free members get 5 free integrated effects instead: Vice Crown, Frost Horns, Bat Mask, Neon Halo and Sunset Cap — every effect is FIXED to the avatar circle as one single piece, like a crown, mask, horns, halo, cap or helmet the avatar wears, never a separate thing floating around it), 3 Premium badges (Premium Member, Vice Elite, Neon Legend), 3 Premium calling cards / banners (Vice Haze, Hydro Vice, Magic Palms — ANIMATED: drifting smoke, swaying neon-green leaves, moving flame; free calling cards are static) and the Vice Crest crew emblem among the 3 Premium crew emblems. Calling Cards are wide, bold COD-style cards (original ViceSunshine designs — dark backgrounds, neon-green leaves, skulls, fire) shown on profiles and crew homes with the owner's name on them, and the equipped card doubles as the profile / crew banner. Three more personal cards are Challenge cards (Dark Vice, Skull Harvest, Vicestronaut): earned Dark-Ops style by completing challenges counted automatically in-app (reach Level 5, make 10 Feed posts, RSVP Going to 5 events) — locked until earned, never for sale, and not part of the 5 free + 3 Premium catalogue. Presence works like Discord: from the profile's Add Status bubble or Settings, the Change Online Status sheet offers Online (green dot), Idle (yellow moon — stored as Away), Do Not Disturb (red minus) and Invisible (grey — stored as Ghost: the player appears Offline to everyone else while actually online), plus 'Set a custom status' for a short custom status text shown on the profile; anyone inactive for over 5 minutes shows as Offline. Players can also upload their OWN avatar / profile picture on their profile (JPG or PNG, up to 4 MB): every upload is checked by automatic moderation BEFORE it is stored — nude, sexual or illegal pictures are blocked and never stored — and a custom picture replaces the catalogue avatar everywhere until removed or a catalogue avatar is equipped. Vice Credits cannot be bought — they are only earned from in-app activity, level milestones, community events, seasonal awards and the Premium weekly grant; they are used for creating a crew (500) and member contributions to a crew wallet, and never buy Rank Points, levels, rank or wins. Premium is the ONLY thing that can be paid for, and payments are NOT connected yet — checkout is coming soon, no payment is taken and Premium never starts before a successful payment.",
        "- Premium: CA$4.99/month — the ONLY paid thing in ViceSunshine. Benefits, all enforced by the app: ad-free (Premium members see no ad spaces at all), 250 Vice Credits every week while active (paid into the personal wallet; stops if Premium lapses, no back-pay), larger crew limit (a crew founded or led by a Premium member holds 200 members instead of 50), a custom Premium Member profile badge, early event access (Premium members can RSVP Going during an event's first 48 hours; everyone else can RSVP Going after that window), and the custom Vice Crest crew emblem.",
        "- Events: community events (car meets, races, crew meets, time trials, contests) hosted by crew Leaders whose crew has at least 10 members; find them by name or hashtag on the Events page. The hosting crew's Leader — and only that Leader — controls the event: they can edit it, switch it between Public and Private at any time, post its results and remove it completely. Lobby details are shown only to players who RSVP Going. GTA VI is single-player at launch — these are community meetups/challenges, not official in-game multiplayer.",
        "- Database: Vehicles, Weapons and Characters entries are maintained ONLY by the ViceSunshine team from official Rockstar sources and update automatically as official information changes — players cannot add, suggest or edit Database entries, and there is no suggestion form anymore. Every status badge (Confirmed in trailer / Reported / Unverified / Returning from GTA V) is generated from the entry's data; returning GTA V items are NOT confirmed for GTA VI. If a player thinks an entry is wrong, they can raise it in a support request and a human checks it against the official source.",
        "- Discord server: ViceSunshine has NO in-app voice calls and no Party Calls. Voice chat, hanging out and joining lobbies together happen on the ViceSunshine Discord server — the one Join our Discord server card is on the Create Account (Sign Up) page, in the final step after linking accounts (it appears nowhere else). The invite link is LIVE: https://discord.gg/NDH9XxyVkW — the card's Join button opens it, and it is the admin value set in Settings (Connectors, ViceSunshine Discord server — admin), so changing it there updates the card. Event pages can also show a host-shared lobby link for Going players as well.",
        "- Support scope: Vice helps with ViceSunshine only (accounts, credits, Premium, crews, events, reports). Vice is NOT Rockstar support. Never ask for passwords, card details or account codes. Problems Vice cannot fix itself (payment issues, bans, credit disputes, reports needing review) need a human: needsHuman = true and tell the player to send a support request with what happened, when, and their username.",
        "",
        "HOW TO USE VICESUNSHINE — step-by-step guides (when a player asks HOW to do something, walk them through these exact steps in simple language and link the page named at the end):",
        "- Create an account: 1) Tap Create Account (bottom of the left sidebar on desktop, or the menu on phone). 2) Step 1: pick a gamertag, your platform and a short bio, then continue. 3) Step 2 (Link & join): type your PSN ID and Xbox gamertag if you want them shown on your profile, and tap Join on the Discord server card if you want in. 4) Tap Save & finish at the very bottom. You start with 500 Vice Credits. (Page: signup)",
        "- Link PSN / Xbox / Discord later: open your Profile, tap Edit profile, and type your PSN ID, Xbox gamertag or Discord username in the linked-accounts fields, then save. These are typed display links — Sony and Microsoft do not offer 'Sign in with PlayStation/Xbox' for fan sites, so there is no password and no sign-in, just your names shown on your profile. Discord voice chat itself lives in the Discord server, joined from the Create Account page's Discord card. (Page: profile)",
        "- Rockstar Social Club ID (optional): on Create Account step 2 or in Edit profile, type your Social Club ID in the Rockstar field and choose who can see it — Private (the default: only you and your crew) or Public (everyone). Players add each other by tapping Copy or 'Add on Rockstar' next to a Rockstar ID on a profile, in the player directory, on a crew roster — that copies the ID, ready to paste into Social Club's friend search. There is no Rockstar sign-in and ViceSunshine never asks for a Rockstar password. (Page: profile)",
        "- Join a crew: 1) Open Crews. 2) Browse or search for a crew you like. 3) Open it and tap Join (private crews ask the leader to approve). Joining pays a +50 Vice Credits welcome bonus once per crew. (Page: clans)",
        "- Create a crew: 1) Open Crews and tap Create a crew. 2) Choose a name, tag, colour and emblem. 3) Confirm — creating a crew costs 500 Vice Credits from your own wallet, so you need at least 500. (Page: clans)",
        "- Post in the Feed: 1) Open the Community Feed. 2) Use the composer at the top: write your post, pick a category (Clips, Funny, Memes, Gameplay and more), add a video link if it is a clip. 3) Tap Post. Posting earns +5 XP. (Page: feed)",
        "- Watch Clips: open Clips for the vertical, swipe-up clip player — swipe up for the next clip, and use the buttons on the right to like, comment, save, share and follow the creator. Clips play inside ViceSunshine. (Page: clips)",
        "- Post a Story: from the Stories row at the top of the Feed, or from your Profile, tap Your Story +, write or pick your moment and post it. Stories last 24 hours, then move to your View archive on your profile. (Page: feed)",
        "- Save something: tap Save (or the bookmark) on any news story, guide, bug, crew or Feed post. Everything you save collects on the Saved page, and your saved posts, videos and ideas are also in your Profile's Saved tab. (Page: saved)",
        "- Search: tap the magnifying-glass icon (top of the app; on phone it is just the icon). Type what you want — results group into News, Feed, Bugs, Guides, Crews, Players and Database as you type; press Enter for the full results page. (Page: home)",
        "- Send a message: 1) Open Messages. 2) Tap the new-message icon. 3) Pick the player and write your message. Message requests from people you do not follow sit under Requests until you accept. (Page: messages)",
        "- Follow a player: open their profile and tap Follow. Your Posts / Followers / Following counts on your own profile update on their own, starting from 0. (Page: profile)",
        "- Join an event: 1) Open Events. 2) Find one by name or hashtag (like #carmeet). 3) Open it and tap RSVP Going — lobby details only appear once you are Going. Crew leaders whose crew has 10+ members can create events from the same page. (Page: events)",
        "- Use the Database: open GTA VI Database in the sidebar, pick Vehicles, Weapons or Characters, and filter by Confirmed / Reported / Unverified. Entries are maintained by the ViceSunshine team from official sources; players cannot add entries — if one looks wrong, tell support. (Page: database)",
        "- Mission guides: story mission walkthroughs live in Guides, in the Missions category — open a mission guide for the walkthrough, rewards, tips, its official source link and, where one exists, a video guide. (Page: guides)",
        "- Explore Easter Eggs: open Easter Eggs (or Ideas) and tap any egg to open its page: one video or picture, whether it is Real, a Rumor or Unverified, and one source link to check. (Page: eggs)",
        "- Customise your look: open Customise, pick a section (Avatars, Avatar Effects, Badges, Calling Cards, Themes, crew emblems and colours), and tap Equip — profile and crew customisation is free; the 3 Premium items in each section come with Premium. Your calling card is also your profile banner. (Page: customise)",
        "- Get Premium: open Premium to see the benefits (no ads, 250 Vice Credits every week, Premium items in Customise, bigger crews, early event access) — it is CA$4.99/month, the only paid thing in ViceSunshine. (Page: premium)",
        "- See your growth: on the Home page, tap the Your Profile card — it opens your Profile analytics: a growth graph for followers, likes, views, posts, comments, saves and reposts, with what grew and what went down this week. (Page: analytics)",
        "- Change settings: tap your name/avatar at the bottom left of the sidebar (on phone, open the menu drawer and tap Settings and privacy), then Settings in the small box that opens. There you can change your username, profile privacy, password/email, language, currency and saved payment info, and read the legal pages. (Page: profile)",
        "- Report or block: tap the menu on any post or profile and choose Report — a human reviews reports. Blocked players are managed in Settings. For anything Vice cannot fix, use Contact support in this chat and a human on the team will review it.",
        "",
        "MATCHED VICESUNSHINE CONTENT:",
        ...latestNews.map((n) => `LATEST NEWS [${n.category}] ${n.publishedAt} — ${n.title}: ${n.summary} (source: ${n.sourceName || "ViceSunshine"} ${n.sourceUrl})`),
        ...news.filter((n) => !latestNews.some((l) => l.id === n.id)).map((n) => `NEWS [${n.category}] ${n.publishedAt} — ${n.title}: ${n.summary} (source: ${n.sourceName || "ViceSunshine"} ${n.sourceUrl})`),
        ...guides.map((g) => `GUIDE [${g.category}] — ${g.title}: ${g.body.slice(0, 220)}`),
        ...entries.map((e) => `DATABASE ${e.kind} — ${e.name} (${e.category}): status ${e.status}. ${e.description} (source: ${e.sourceName || "none"} ${e.sourceUrl})`),
        ...events.map((e) => `PUBLIC EVENT [${e.type}] — ${e.title} at ${e.startsAt} (${e.timezone}), hosted by ${e.host}`),
        ...eggs.map((e) => `EASTER EGG — ${e.name} (${e.location}): status ${e.status}. ${e.howTo.slice(0, 160)}`),
        ...bugs.map((b) => `BUG [${b.status}] — ${b.title} (${b.platform}): ${b.description.slice(0, 140)}`),
        ...crews.map((c) => `CREW — ${c.name} [${c.tag}] (${c.platform}): ${c.motto || c.description.slice(0, 100)}`),
        ...latestFeed.map((p) => `LATEST FEED POST by ${p.author} [${p.kind}] — ${p.title || p.body.slice(0, 120)}`),
        latestPatch ? `LATEST PATCH — version ${latestPatch.version}, released ${latestPatch.releaseDate}, PS5 ${latestPatch.sizePs5}, Xbox ${latestPatch.sizeXbox}, notes: ${latestPatch.notes}` : "No patches are listed yet.",
        "",
        `ACCOUNT (the player asking — the ONLY person's private details you may ever discuss): ${account}`,
      ].join("\n");

      const fallbackLinks = [
        ...(entries.length ? [{ label: "Open the Database", tab: "database", url: "" }] : []),
        ...(events.length ? [{ label: "Open Events", tab: "events", url: "" }] : []),
        ...(news.length ? [{ label: "Open News", tab: "news", url: "" }] : []),
      ];
      const allowedUrls = new Set<string>([
        "https://www.rockstargames.com/VI",
        ...newsRows.map((n) => n.sourceUrl),
        ...latestNews.map((n) => n.sourceUrl),
        ...dbRows.map((e) => e.sourceUrl),
      ].filter((u) => typeof u === "string" && u.startsWith("https://")));
      const historyText = args.history.length
        ? `\nCONVERSATION SO FAR (context only — facts still come only from CONTEXT):\n${args.history.map((h) => `${h.role === "user" ? "Player" : "Vice"}: ${h.text}`).join("\n")}\n`
        : "";
      try {
        const result = await ctx.inference.complete(
          `You are Vice, the AI helper and website guide inside ViceSunshine, an unofficial fan-made GTA VI community app. You are an AI, not a person, and not affiliated with Rockstar Games or Take-Two. You only ever answer when a player asks you something — never raise topics yourself. Answer the player's question using ONLY the context below. Rules: never invent a mission, weapon, vehicle, character, patch note, map location, news story or feature; if the context does not cover it, say you do not know and point to the official Rockstar site (https://www.rockstargames.com/VI) or the relevant ViceSunshine page. Always label Rumor as Rumor and Unverified as Unverified; returning GTA V items are NOT confirmed for GTA VI. GTA VI launches November 19, 2026 on PS5 and Xbox Series X|S, single-player at launch; no GTA VI Online has been announced. Keep answers short, friendly and in simple language. HOW-TO questions: when a player asks how to do something on the website, answer as a guide — short numbered steps taken from the HOW TO USE VICESUNSHINE section, in plain simple words, and link the exact page the steps happen on. NEWS questions: answer from LATEST NEWS / NEWS in the context, name the source, and include that story's own official link as a url link labelled "View official post" when the context gives one.

PRIVACY — HARD RULES, no exceptions: You may only discuss (1) the player asking — their own account line, profile, posts, crew and Premium — and (2) public ViceSunshine content (news, database, guides, public events, public crews, public feed posts). NEVER reveal, guess or confirm another person's private information: no other user's email, password, payment details, private messages, private profile details, saved items, private events, lobby details, invite codes or account details. That information is not in your context and you must never invent it. If a player asks for someone else's private information, refuse clearly and kindly: explain you cannot share other people's private information, and offer to help with their own account or with public content instead. Never ask anyone for passwords, card details or codes.

links: include 1-3 helpful links — tab must be one of home, news, updates, bugs, map, eggs, guides, database, clans, events, profile, premium, customise, feed, clips, messages, challenges, analytics, signup, saved, ideas, goals (or "" with url set to an official source URL that appears in the context, labelled "View official post" for a news story's own link, or the official Rockstar page). needsHuman: true only when the problem needs a human (payment issue, ban, credit dispute, report needing review, anything you cannot fix) — then clearly say a human needs to review it and invite them to send a support request with what happened, when, and their username. Never promise a refund or a fix.

CONTEXT:
${context}
${historyText}
QUESTION: ${args.question}`,
          {
            schema: z.object({
              answer: z.string(),
              links: z.array(z.object({ label: z.string(), tab: z.string(), url: z.string() })),
              needsHuman: z.boolean(),
            }),
          },
        );
        const validTabs = new Set(["home", "news", "updates", "bugs", "map", "eggs", "guides", "database", "clans", "events", "profile", "premium", "customise", "feed", "clips", "messages", "challenges", "analytics", "signup", "saved", "ideas", "goals"]);
        return {
          answer: result.answer,
          links: result.links
            .filter((l) => validTabs.has(l.tab) || allowedUrls.has(l.url))
            .slice(0, 3)
            .map((l) => (validTabs.has(l.tab)
              ? { label: l.label || "Open", tab: l.tab, url: "" }
              : { label: l.label || "View official post", tab: "", url: l.url })),
          needsHuman: result.needsHuman,
        };
      } catch {
        const bits: string[] = [];
        if (latestNews.length) bits.push(`The latest news: ${latestNews.map((n) => `${n.title} (${n.sourceName || "ViceSunshine"})`).join("; ")}.`);
        if (entries.length) bits.push(`In the Database: ${entries.map((e) => `${e.name} (${e.kind}, ${e.status})`).join("; ")}.`);
        if (events.length) bits.push(`Matching public events: ${events.map((e) => `${e.title} — ${e.startsAt}`).join("; ")}.`);
        if (eggs.length) bits.push(`Matching Easter eggs: ${eggs.map((e) => `${e.name} (${e.status})`).join("; ")}.`);
        if (news.length) bits.push(`More matching news: ${news.map((n) => n.title).join("; ")}.`);
        return {
          answer: bits.length
            ? `Here is what I found in ViceSunshine: ${bits.join(" ")} I could not compose a fuller answer just now — the pages linked below have the details.`
            : "I could not find that in ViceSunshine's News, Guides, Database or Events, and I do not want to guess. Try the official Rockstar site, or rephrase and I will search again.",
          links: fallbackLinks.length ? fallbackLinks : [{ label: "Check the official Rockstar site", tab: "", url: "https://www.rockstargames.com/VI" }],
          needsHuman: false,
        };
      }
    },
  }),

  createSupportRequest: defineAction({
    description: "Creates a support request for the ViceSunshine team (human review). Used by Vice when a problem cannot be fixed in-app — payment issues, bans, credit disputes, reports needing review. Never collects passwords or card details.",
    request: z.object({
      playerKey: z.string().max(80).default(""),
      gamertag: z.string().max(60).default(""),
      topic: z.enum(["Credits", "Premium / payment", "Crew problem", "Account / ban", "Report a player or post", "Event / RSVP", "Other"]).default("Other"),
      details: z.string().min(10).max(1200),
    }),
    response: z.object({ ok: z.literal(true), id: z.number() }),
    async handler(ctx, args): Promise<{ ok: true; id: number }> {
      const db = ctx.db<typeof schema>();
      const lower = args.details.toLowerCase();
      if (/(password|card number|cvv|pin code|verification code is)/.test(lower)) {
        throw new Error("Please do not include passwords, card details or private codes — ViceSunshine support will never ask for them. Describe the problem without them.");
      }
      const [row] = await db
        .insert(schema.supportRequests)
        .values({ playerKey: args.playerKey, gamertag: args.gamertag, topic: args.topic, details: args.details.trim(), status: "Open" })
        .returning({ id: schema.supportRequests.id });
      ctx.invalidateQueries();
      return { ok: true, id: row?.id ?? 0 };
    },
  }),

  seedExamples: defineAction({
    description: "Seeds clearly-labelled community example posts in the Community Feed (one per category) and example community events (Car Meet, Street Race, Screenshot Contest), seeds the starter ViceSunshine Guides library (beginner, money, cars, weapons, missions, map, tips, settings, fixes — written from confirmed launch facts and trailer-sourced information, with unconfirmed items labelled), and runs the automatic Database sync: the Database catalog is maintained only by the ViceSunshine team from official Rockstar sources — new entries are added, statuses and details updated, and non-catalog entries (old user suggestions) removed, because users cannot add or edit Database entries. Idempotent: the seed parts only run while their content does not exist yet; the Database sync is safe to run any time. Examples are marked as community examples, never official Rockstar content.",
    request: z.object({}),
    response: z.object({ feedAdded: z.number(), eventsAdded: z.number(), dbAdded: z.number(), dbUpdated: z.number(), dbRemoved: z.number(), guidesAdded: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      // Clan Wars were removed from ViceSunshine (replaced by
      // Community Events): clear any orphaned rows the old weekly
      // war left behind. The tables stay in the schema, unused —
      // no action reads or writes them anymore.
      await db.delete(schema.warActivity);
      await db.delete(schema.clanWarEntries);
      await db.delete(schema.clanWars);
      // The old team-seeded example event was a "Clan War Showcase
      // Night" — retitle that example row to the Screenshot Contest
      // example the seed uses now, so no Clan War wording survives
      // in the Events list either. (Example rows only — the host
      // marker identifies them; player-created events are untouched.)
      await db
        .update(schema.events)
        .set({
          title: "Community example — Leonida Screenshot Contest",
          type: "Screenshot Contest",
          description:
            "Community example event — not official, and not in-game multiplayer. A community screenshot contest: explore Leonida, take your best shot, and share it in the Feed. Find events like this by searching #screenshot in Events.",
          prize: "Bragging rights + site badge",
          hashtags: "screenshot contest photo",
        })
        .where(and(eq(schema.events.host, "ViceSunshine Community (example)"), or(like(schema.events.title, "%Clan War%"), like(schema.events.title, "%Crew War%"))));
      let feedAdded = 0;
      const existingFeed = await db
        .select()
        .from(schema.feedPosts)
        .where(eq(schema.feedPosts.authorKey, FEED_EXAMPLE_KEY));
      if (existingFeed.length === 0) {
        const label = "Community example — not official Rockstar content. ";
        const examples: { kind: string; title: string; body: string }[] = [
          { kind: "Clip", title: "Your first Leonida clip goes here", body: `${label}This is how a Clip post looks: a short clip (up to 60 seconds) you recorded yourself, or a link to your own YouTube clip. Tap a video to play it — nothing autoplays.` },
          { kind: "Funny", title: "The traffic jam that became a swimming pool", body: `${label}A Funny post is a short, silly moment from your own game — a pile-up, a physics glitch, a boat where no boat should be. Post your own clip or screenshot, and keep it kind.` },
          { kind: "Meme", title: "When the GPS says 'recalculating' for the fifth time", body: `${label}A Meme post is an original meme you made. No reposting other people's memes without credit, and no leaked footage dressed up as a joke.` },
          { kind: "Streamer Clip", title: "Streamer clip — always credit the creator", body: `${label}A Streamer Clip post links to the original creator's clip with their name credited here. Never re-upload someone else's stream as your own.` },
          { kind: "Tutorial", title: "Best controller settings to start with", body: `${label}A Tutorial post teaches one thing step by step — settings, a money method, a driving technique. Longer written guides live in the Guides section; link yours there too.` },
          { kind: "Gameplay", title: "A sunset drive along the coast road", body: `${label}A Gameplay post is your own gameplay — a drive, a chase, a quiet moment. Your clip or a link to your own channel only. No leaked footage, ever.` },
          { kind: "Car Meet", title: "Friday night car meet — community organised", body: `${label}A Car Meet post shows the cars and shares the plan. Turn it into a real meet by creating it in Events, where players can RSVP and the host shares lobby details with Going players only.` },
          { kind: "News", title: "How to check a rumour before sharing it", body: `${label}A News post links its source, and the official Rockstar link at the top of this feed lets anyone double-check it. If a post promises a free GTA VI download, report it — that is always a scam.` },
          { kind: "Discussion", title: "Jason or Lucia first?", body: `${label}A Discussion post is a question or a take for the community. Keep it friendly, mark spoilers clearly, and remember nobody here has official answers — the game launches November 19, 2026.` },
        ];
        for (const ex of examples) {
          await db.insert(schema.feedPosts).values({
            authorKey: FEED_EXAMPLE_KEY,
            author: "ViceSunshine Community",
            kind: ex.kind as typeof schema.feedPosts.$inferInsert.kind,
            title: ex.title,
            body: ex.body,
            mediaUrl: "",
          });
          feedAdded += 1;
        }
      }
      let eventsAdded = 0;
      const existingEvents = await db.select().from(schema.events);
      if (!existingEvents.some((e) => e.host === "ViceSunshine Community (example)")) {
        const day = 24 * 60 * 60 * 1000;
        const at = (days: number, hour: number) => {
          const d = new Date(Date.now() + days * day);
          d.setUTCHours(hour, 0, 0, 0);
          return d.toISOString();
        };
        const evs = [
          {
            title: "Community example — Friday Night Car Meet",
            type: "Car Meet",
            startsAt: at(3, 0),
            description: "Community example event — not official, and not in-game multiplayer. A relaxed community car meet: bring your cleanest build, park up, and share screenshots afterwards in the Feed.",
            rules: "No griefing, no ramming. Clean cars only for the group photo.",
            prize: "Bragging rights + site badge",
          },
          {
            title: "Community example — Coast Road Street Race",
            type: "Race / Street Race",
            startsAt: at(5, 1),
            description: "Community example event — not official, and not in-game multiplayer. A community time-trial style street race challenge: run the coast road, post your time, and the host confirms the top 3 in Events.",
            rules: "Stock cars only. One run per player. Host's confirmed results are final.",
            prize: "Bragging rights + Rank Points for the winners' crews",
          },
          {
            title: "Community example — Leonida Screenshot Contest",
            type: "Screenshot Contest",
            startsAt: at(7, 0),
            description: "Community example event — not official, and not in-game multiplayer. Take your best Leonida screenshot, post it in the Feed, and the host picks the winners in Events. Find events like this one by searching #screenshot.",
            rules: "Your own screenshots only. One entry per player. Host's picks are final.",
            prize: "Bragging rights + Rank Points for the winners",
          },
        ];
        for (const ev of evs) {
          await db.insert(schema.events).values({
            ...ev,
            timezone: "America/New_York",
            platform: "Both",
            maxPlayers: 30,
            host: "ViceSunshine Community (example)",
            visibility: "Public" as const,
            hashtags: "",
            hostClanName: "",
            lobbyDetails: "Lobby details are shared by the host, only for RSVP'd players. For this example: the host posts the meet point here for Going players on the day.",
            lobbyLink: "",
          });
          eventsAdded += 1;
        }
      }
      // ---- Database sync — AUTOMATIC, team-maintained only ----
      // Users cannot add or edit Database entries. The catalog below
      // (maintained by the ViceSunshine team from official Rockstar
      // sources) is the only source of entries: every run adds new
      // catalog entries, updates stored ones to the catalog's status
      // and details (so status badges are automatic from official
      // data), and removes stored entries that are not in the
      // catalog — which can only be old user suggestions from before
      // suggestions were removed — together with their ratings.
      // Guide category rename (owner): "Cars" guides are Vehicles
      // guides now — the guide covers every vehicle, not just cars.
      await db.update(schema.guides).set({ category: "Vehicles" }).where(eq(schema.guides.category, "Cars"));
      let dbAdded = 0;
      let dbUpdated = 0;
      let dbRemoved = 0;
      const existingDb = await db.select().from(schema.dbEntries);
      // The two protagonists Rockstar has officially named and shown
      // in its own trailers, linked to Rockstar's official GTA VI
      // page — the only Confirmed in trailer entries at launch.
      const protagonists: {
        kind: "Character"; name: string; category: string; description: string;
        status: "Confirmed in trailer"; sourceName: string; sourceUrl: string; featured: number;
        type?: string; manufacturer?: string;
      }[] = [
        {
          kind: "Character",
          name: "Jason Duval",
          category: "Protagonist",
          description:
            "One of the two playable protagonists, officially introduced by Rockstar in Trailer 2 and on the official GTA VI page. A Leonida local drawn back into a life of crime alongside Lucia.",
          status: "Confirmed in trailer",
          sourceName: "Rockstar Games — official GTA VI page",
          sourceUrl: "https://www.rockstargames.com/VI",
          featured: 1,
        },
        {
          kind: "Character",
          name: "Lucia Caminos",
          category: "Protagonist",
          description:
            "One of the two playable protagonists, officially introduced by Rockstar in Trailer 1 and on the official GTA VI page. Fresh out of Leonida Penitentiary at the start of the story, partnered with Jason.",
          status: "Confirmed in trailer",
          sourceName: "Rockstar Games — official GTA VI page",
          sourceUrl: "https://www.rockstargames.com/VI",
          featured: 1,
        },
      ];
      // Catalog names the community tracks (names only — every
      // description below is ViceSunshine's own wording). Returning GTA V
      // items are labelled "Returning from GTA V" and are NEVER
      // presented as confirmed for GTA VI; names with no solid public
      // basis are "Unverified"; supporting characters are "Reported"
      // from official-material coverage, linked to the official page
      // so anyone can double-check.
      const returningNote = "Known from GTA V / GTA Online. Not confirmed for GTA VI — listed so the community can track whether it returns.";
      const unverifiedNote = "Tracked by the community from public discussion. Not confirmed for GTA VI — no official source has named it yet.";
      const catalog: {
        kind: "Vehicle" | "Weapon" | "Character" | "Location"; name: string; category: string;
        description: string; status: "Returning from GTA V" | "Unverified" | "Reported";
        sourceName: string; sourceUrl: string; type?: string; manufacturer?: string; drivetrain?: string; featured?: number;
      }[] = [
        { kind: "Weapon", name: "556", category: "Assault Rifles", description: unverifiedNote, status: "Unverified", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "ADB FRA", category: "Assault Rifles", description: unverifiedNote, status: "Unverified", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Carbine", category: "Assault Rifles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Carbine Rifle Mk II", category: "Assault Rifles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Hillinger Heathen", category: "Assault Rifles", description: unverifiedNote, status: "Unverified", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Kozlov Hind", category: "Assault Rifles", description: unverifiedNote, status: "Unverified", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Kozlov KZ-59", category: "Assault Rifles", description: unverifiedNote, status: "Unverified", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Vom Feuer VF-G1", category: "Assault Rifles", description: unverifiedNote, status: "Unverified", sourceName: "", sourceUrl: "", manufacturer: "Vom Feuer" },
        { kind: "Vehicle", name: "Buccaneer", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Albany", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Buccaneer Custom", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Albany", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Chino", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Deviant", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Schyster", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Dominator", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Dominator ASP", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Dominator GT", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "2-door convertible", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Dominator GTX", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Sabre Turbo", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Declasse", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Sabre Turbo Custom", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Declasse", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Vigero", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Declasse", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Phoenix", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Imponte", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Gauntlet", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Bravado", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Dukes", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Imponte", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Stallion", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Declasse", type: "2-door convertible", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Blade", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "2-door convertible", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Hermes", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Albany", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Hustler", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Impaler", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Declasse", type: "4-door sedan", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Nightshade", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Imponte", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Ruiner", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Imponte", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Slamvan", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "Pickup truck", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Tampa", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Declasse", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Voodoo", category: "Muscle", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Declasse", type: "4-door sedan", drivetrain: "RWD" },
        // ---- Full-catalog expansion (owner direction: everything
        // Tracker-style trackers list — 100+ vehicles, every weapon
        // class, every character, plus Locations). GTA V / GTA Online
        // items are "Returning from GTA V" — tracked, NEVER shown as
        // confirmed for GTA VI. Rumoured names are "Unverified".
        { kind: "Vehicle", name: "Elegy RH8", category: "Sports", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Annis", type: "2-door coupe", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Sultan", category: "Sports", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Karin", type: "4-door sedan", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Banshee", category: "Sports", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Bravado", type: "2-door convertible", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Comet", category: "Sports", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Pfister", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Coquette", category: "Sports", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Invetero", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Feltzer", category: "Sports", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Benefactor", type: "2-door convertible", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Jester", category: "Sports", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Dinka", type: "2-door coupe" },
        { kind: "Vehicle", name: "Massacro", category: "Sports", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Dewbauchee", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Kuruma", category: "Sports", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Karin", type: "4-door sedan", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Futo", category: "Sports", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Karin", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Penumbra", category: "Sports", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Maibatsu", type: "2-door coupe", drivetrain: "FWD" },
        { kind: "Vehicle", name: "Carbonizzare", category: "Sports", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Grotti", type: "2-door convertible", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Adder", category: "Super", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Truffade", type: "2-door coupe", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Zentorno", category: "Super", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Pegassi", type: "2-door coupe", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Turismo R", category: "Super", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Grotti", type: "2-door coupe" },
        { kind: "Vehicle", name: "Infernus", category: "Super", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Pegassi", type: "2-door coupe" },
        { kind: "Vehicle", name: "Vacca", category: "Super", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Pegassi", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Bullet", category: "Super", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Cheetah", category: "Super", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Grotti", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Entity XF", category: "Super", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Overflod", type: "2-door coupe", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Osiris", category: "Super", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Pegassi", type: "2-door coupe", drivetrain: "AWD" },
        { kind: "Vehicle", name: "T20", category: "Super", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Progen", type: "2-door coupe", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Z-Type", category: "Sports Classics", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Truffade", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Monroe", category: "Sports Classics", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Pegassi", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "JB 700", category: "Sports Classics", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Dewbauchee", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Stinger", category: "Sports Classics", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Grotti", type: "2-door convertible", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Coquette Classic", category: "Sports Classics", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Invetero", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Casco", category: "Sports Classics", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Lampadati", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Mamba", category: "Sports Classics", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Declasse", type: "2-door convertible", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Stirling GT", category: "Sports Classics", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Benefactor", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Exemplar", category: "Coupes", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Dewbauchee", type: "4-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Jackal", category: "Coupes", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Ocelot", type: "4-door coupe" },
        { kind: "Vehicle", name: "Felon", category: "Coupes", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Lampadati", type: "4-door sedan", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Felon GT", category: "Coupes", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Lampadati", type: "2-door convertible", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Oracle", category: "Coupes", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Ubermacht", type: "4-door sedan", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Zion", category: "Coupes", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Ubermacht", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Sentinel", category: "Coupes", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Ubermacht", type: "2-door convertible", drivetrain: "RWD" },
        { kind: "Vehicle", name: "F620", category: "Coupes", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Ocelot", type: "2-door coupe", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Tailgater", category: "Sedans", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Obey", type: "4-door sedan" },
        { kind: "Vehicle", name: "Schafter", category: "Sedans", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Benefactor", type: "4-door sedan", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Washington", category: "Sedans", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Albany", type: "4-door sedan", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Primo", category: "Sedans", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Albany", type: "4-door sedan", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Stanier", category: "Sedans", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "4-door sedan", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Ingot", category: "Sedans", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vulcar", type: "Station wagon", drivetrain: "FWD" },
        { kind: "Vehicle", name: "Asterope", category: "Sedans", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Karin", type: "4-door sedan", drivetrain: "FWD" },
        { kind: "Vehicle", name: "Fugitive", category: "Sedans", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Cheval", type: "4-door sedan", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Baller", category: "SUVs", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Gallivanter", type: "SUV", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Huntley S", category: "SUVs", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Enus", type: "SUV", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Rocoto", category: "SUVs", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Obey", type: "SUV", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Dubsta", category: "SUVs", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Benefactor", type: "SUV", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Astron", category: "SUVs", description: returningNote, status: "Returning from GTA V", sourceName: "Rockstar Games — official GTA VI page", sourceUrl: "https://www.rockstargames.com/VI", type: "SUV", manufacturer: "Pfister", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Gresley", category: "SUVs", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Bravado", type: "SUV", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Mesa", category: "SUVs", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Canis", type: "SUV", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Patriot", category: "SUVs", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Mammoth", type: "SUV", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Radius", category: "SUVs", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "SUV" },
        { kind: "Vehicle", name: "Rancher XL", category: "Off-Road", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Declasse", type: "SUV", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Blazer", category: "Off-Road", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Nagasaki", type: "Quad bike" },
        { kind: "Vehicle", name: "Caracara 4x4", category: "Off-Road", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "Pickup truck", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Kamacho", category: "Off-Road", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Canis", type: "Pickup truck", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Liberator", category: "Off-Road", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "Monster truck", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Hellion", category: "Off-Road", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Annis", type: "Pickup truck", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Sandking XL", category: "Off-Road", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "Pickup truck", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Rebel", category: "Off-Road", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Karin", type: "Pickup truck", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Dune Buggy", category: "Off-Road", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "BF", type: "Buggy", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Dubsta 6x6", category: "Off-Road", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Benefactor", type: "Pickup truck", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Bobcat XL", category: "Pickups", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "Pickup truck" },
        { kind: "Vehicle", name: "Sadler", category: "Pickups", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "Pickup truck" },
        { kind: "Vehicle", name: "Bison", category: "Pickups", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Bravado", type: "Pickup truck" },
        { kind: "Vehicle", name: "Bodhi", category: "Pickups", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Canis", type: "Pickup truck", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Contender", category: "Pickups", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "Pickup truck", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Bati 801", category: "Motorcycles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Pegassi", type: "Motorcycle" },
        { kind: "Vehicle", name: "Akuma", category: "Motorcycles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Dinka", type: "Motorcycle" },
        { kind: "Vehicle", name: "PCJ 600", category: "Motorcycles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Shitzu", type: "Motorcycle" },
        { kind: "Vehicle", name: "Sanchez", category: "Motorcycles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Maibatsu", type: "Motorcycle" },
        { kind: "Vehicle", name: "Double T", category: "Motorcycles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Dinka", type: "Motorcycle" },
        { kind: "Vehicle", name: "Hakuchou", category: "Motorcycles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Shitzu", type: "Motorcycle" },
        { kind: "Vehicle", name: "Ruffian", category: "Motorcycles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Pegassi", type: "Motorcycle" },
        { kind: "Vehicle", name: "Vader", category: "Motorcycles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Shitzu", type: "Motorcycle" },
        { kind: "Vehicle", name: "Lectro", category: "Motorcycles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Principe", type: "Motorcycle" },
        { kind: "Vehicle", name: "Enduro", category: "Motorcycles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Dinka", type: "Motorcycle" },
        { kind: "Vehicle", name: "Faggio", category: "Scooter", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Pegassi", type: "Scooter" },
        { kind: "Vehicle", name: "BMX", category: "Cycles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", type: "Bicycle" },
        { kind: "Vehicle", name: "Scorcher", category: "Cycles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", type: "Mountain bike" },
        { kind: "Vehicle", name: "Speeder", category: "Boats", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Pegassi", type: "Speedboat" },
        { kind: "Vehicle", name: "Jetmax", category: "Boats", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Shitzu", type: "Speedboat" },
        { kind: "Vehicle", name: "Squalo", category: "Boats", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Shitzu", type: "Speedboat" },
        { kind: "Vehicle", name: "Suntrap", category: "Boats", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Shitzu", type: "Sailing boat" },
        { kind: "Vehicle", name: "Marquis", category: "Boats", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Dinka", type: "Sailing yacht" },
        { kind: "Vehicle", name: "Seashark", category: "Boats", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Speedophile", type: "Jet ski" },
        { kind: "Vehicle", name: "Dinghy", category: "Boats", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Nagasaki", type: "Inflatable boat" },
        { kind: "Vehicle", name: "Tropic", category: "Boats", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Shitzu", type: "Cabin cruiser" },
        { kind: "Vehicle", name: "Luxor", category: "Planes", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Buckingham", type: "Private jet" },
        { kind: "Vehicle", name: "Velum", category: "Planes", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Mammoth", type: "Propeller plane" },
        { kind: "Vehicle", name: "Duster", category: "Planes", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Western", type: "Crop duster" },
        { kind: "Vehicle", name: "Mallard", category: "Planes", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Western", type: "Stunt plane" },
        { kind: "Vehicle", name: "Cuban 800", category: "Planes", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Mammoth", type: "Propeller plane" },
        { kind: "Vehicle", name: "Dodo", category: "Planes", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Mammoth", type: "Seaplane" },
        { kind: "Vehicle", name: "Hydra", category: "Planes", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Mammoth", type: "Fighter jet" },
        { kind: "Vehicle", name: "Besra", category: "Planes", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Western", type: "Jet trainer" },
        { kind: "Vehicle", name: "Buzzard", category: "Helicopters", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Nagasaki", type: "Attack helicopter" },
        { kind: "Vehicle", name: "Maverick", category: "Helicopters", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Buckingham", type: "Helicopter" },
        { kind: "Vehicle", name: "Frogger", category: "Helicopters", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Maibatsu", type: "Helicopter" },
        { kind: "Vehicle", name: "Annihilator", category: "Helicopters", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Western", type: "Attack helicopter" },
        { kind: "Vehicle", name: "Cargobob", category: "Helicopters", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Western", type: "Cargo helicopter" },
        { kind: "Vehicle", name: "Swift", category: "Helicopters", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Buckingham", type: "Helicopter" },
        { kind: "Vehicle", name: "Police Cruiser", category: "Emergency", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "Police car", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Sheriff SUV", category: "Emergency", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Declasse", type: "Police SUV", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Ambulance", category: "Emergency", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Brute", type: "Ambulance", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Fire Truck", category: "Emergency", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "MTL", type: "Fire truck", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Police Riot", category: "Emergency", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Brute", type: "Riot vehicle", drivetrain: "AWD" },
        { kind: "Vehicle", name: "Tipper", category: "Industrial", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Brute", type: "Dump truck" },
        { kind: "Vehicle", name: "Flatbed", category: "Industrial", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "MTL", type: "Flatbed truck" },
        { kind: "Vehicle", name: "Mixer", category: "Industrial", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "HVY", type: "Cement mixer" },
        { kind: "Vehicle", name: "Dozer", category: "Industrial", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "HVY", type: "Bulldozer" },
        { kind: "Vehicle", name: "Dump", category: "Industrial", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "HVY", type: "Mining truck" },
        { kind: "Vehicle", name: "Bus", category: "Service", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Brute", type: "Bus" },
        { kind: "Vehicle", name: "Trashmaster", category: "Service", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Jobuilt", type: "Garbage truck" },
        { kind: "Vehicle", name: "Taxi", category: "Service", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "Taxi", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Tourbus", category: "Service", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Brute", type: "Tour bus" },
        { kind: "Vehicle", name: "Airtug", category: "Utility", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "HVY", type: "Baggage tug" },
        { kind: "Vehicle", name: "Forklift", category: "Utility", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "HVY", type: "Forklift" },
        { kind: "Vehicle", name: "Lawn Mower", category: "Utility", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Stanley", type: "Ride-on mower" },
        { kind: "Vehicle", name: "Tractor", category: "Utility", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Stanley", type: "Farm tractor" },
        { kind: "Vehicle", name: "Caddy", category: "Utility", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Nagasaki", type: "Golf cart" },
        { kind: "Vehicle", name: "Burrito", category: "Vans", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Declasse", type: "Panel van", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Pony", category: "Vans", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Brute", type: "Panel van" },
        { kind: "Vehicle", name: "Rumpo", category: "Vans", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Bravado", type: "Van" },
        { kind: "Vehicle", name: "Speedo", category: "Vans", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "Panel van" },
        { kind: "Vehicle", name: "Surfer", category: "Vans", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "BF", type: "Camper van", drivetrain: "RWD" },
        { kind: "Vehicle", name: "Youga", category: "Vans", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Bravado", type: "Van" },
        { kind: "Vehicle", name: "Minivan", category: "Vans", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "Minivan", drivetrain: "FWD" },
        { kind: "Vehicle", name: "Dominator Buggy", category: "Off-Road", description: unverifiedNote, status: "Unverified", sourceName: "", sourceUrl: "", manufacturer: "Vapid", type: "Buggy", drivetrain: "RWD" },
        { kind: "Weapon", name: "Pistol", category: "Handguns", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Combat Pistol", category: "Handguns", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "AP Pistol", category: "Handguns", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "SNS Pistol", category: "Handguns", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Heavy Pistol", category: "Handguns", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Vintage Pistol", category: "Handguns", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Heavy Revolver", category: "Handguns", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Morgan Revolver", featured: 1, category: "Handguns", description: unverifiedNote, status: "Unverified", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Mustang .357 Revolver", category: "Handguns", description: unverifiedNote, status: "Unverified", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Nipper .38", category: "Handguns", description: unverifiedNote, status: "Unverified", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Sand Storm ES9", category: "Handguns", description: unverifiedNote, status: "Unverified", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Schlamm DRX", category: "Handguns", description: unverifiedNote, status: "Unverified", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Scorpio Akulus", category: "Handguns", description: unverifiedNote, status: "Unverified", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "The Silver 1922", category: "Handguns", description: unverifiedNote, status: "Unverified", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Wortham WCR1", category: "Handguns", description: unverifiedNote, status: "Unverified", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Micro SMG", category: "SMGs", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "SMG", category: "SMGs", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Assault SMG", category: "SMGs", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Combat PDW", category: "SMGs", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Machine Pistol", category: "SMGs", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Pump Shotgun", category: "Shotguns", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Sawed-Off Shotgun", category: "Shotguns", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Assault Shotgun", category: "Shotguns", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Bullpup Shotgun", category: "Shotguns", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Musket", category: "Shotguns", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Heavy Shotgun", category: "Shotguns", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Assault Rifle", category: "Assault Rifles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Advanced Rifle", category: "Assault Rifles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Special Carbine", category: "Assault Rifles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Bullpup Rifle", category: "Assault Rifles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "MG", category: "LMGs", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Combat MG", category: "LMGs", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Gusenberg Sweeper", category: "LMGs", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "ADB M350", category: "LMGs", description: unverifiedNote, status: "Unverified", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Sniper Rifle", category: "Sniper Rifles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Heavy Sniper", category: "Sniper Rifles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Marksman Rifle", category: "Sniper Rifles", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "RPG", category: "Heavy", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Grenade Launcher", category: "Heavy", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Minigun", category: "Heavy", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Railgun", category: "Heavy", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Homing Launcher", category: "Heavy", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Hillinger Boomer", featured: 1, category: "Heavy", description: unverifiedNote, status: "Unverified", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Knife", category: "Melee", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Baseball Bat", category: "Melee", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Crowbar", category: "Melee", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Golf Club", category: "Melee", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Nightstick", category: "Melee", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Hammer", category: "Melee", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Machete", category: "Melee", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Weapon", name: "Battle Axe", category: "Melee", description: returningNote, status: "Returning from GTA V", sourceName: "", sourceUrl: "" },
        { kind: "Character", name: "Brian Heder", category: "Associate", description: "A character reported from official GTA VI material coverage. Only Jason and Lucia are confirmed protagonists \u2014 treat every other detail as unconfirmed until Rockstar publishes more.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page (check the cast there)", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Character", name: "Cal Hampton", category: "Associate", description: "A character reported from official GTA VI material coverage. Only Jason and Lucia are confirmed protagonists \u2014 treat every other detail as unconfirmed until Rockstar publishes more.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page (check the cast there)", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Character", name: "Raul Bautista", category: "Associate", description: "A character reported from official GTA VI material coverage. Only Jason and Lucia are confirmed protagonists \u2014 treat every other detail as unconfirmed until Rockstar publishes more.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page (check the cast there)", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Character", name: "Roxy", category: "Supporting", description: "A character reported from official GTA VI material coverage. Only Jason and Lucia are confirmed protagonists \u2014 treat every other detail as unconfirmed until Rockstar publishes more.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page (check the cast there)", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Location", name: "One Eyed Willies", category: "Mod shop", description: "A diner-and-garage mod shop spotted in official trailer footage. Its exact spot on the map is unverified until players confirm it in-game after launch.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Location", name: "Rideout Customs", category: "Mod shop", description: "A custom car workshop spotted in official trailer footage. Its exact spot on the map is unverified until players confirm it in-game after launch.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Location", name: "Big Shots Wholesale Weapons", category: "Gun store", description: "A wholesale gun store spotted in official trailer footage. Its exact spot on the map is unverified until players confirm it in-game after launch.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Location", name: "Island Dreams", category: "Other", description: "An island bait, tackle and boat charter spot spotted in official trailer footage. Its exact spot on the map is unverified until players confirm it in-game after launch.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Location", name: "Jack of Hearts", category: "Other", description: "A neon nightclub spotted in official trailer footage. Its exact spot on the map is unverified until players confirm it in-game after launch.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Location", name: "Key Lento Fire Department", category: "Other", description: "The fire station on Key Lento, spotted in official trailer footage. Its exact spot on the map is unverified until players confirm it in-game after launch.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Location", name: "Mami's Grocery Market", category: "Other", description: "A neighbourhood grocery market spotted in official trailer footage. Its exact spot on the map is unverified until players confirm it in-game after launch.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Location", name: "Megamundo", category: "Other", description: "A big multi-storey shopping centre spotted in official trailer footage. Its exact spot on the map is unverified until players confirm it in-game after launch.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Location", name: "The Rusty Anchor", category: "Other", description: "A weathered waterfront bar spotted in official trailer footage. Its exact spot on the map is unverified until players confirm it in-game after launch.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Location", name: "Three Sheets Liquor", category: "Other", description: "A small liquor store spotted in official trailer footage. Its exact spot on the map is unverified until players confirm it in-game after launch.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Location", name: "Venture Apartments", category: "Other", description: "An art-deco apartment block spotted in official trailer footage. Its exact spot on the map is unverified until players confirm it in-game after launch.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Location", name: "Jason's Safehouse", featured: 1, category: "Safehouse", description: "The stilt house Jason is seen living in through official trailer footage. Its exact spot on the map is unverified until players confirm it in-game after launch.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Location", name: "Lucia's Apartment", category: "Safehouse", description: "The apartment Lucia is linked to in official trailer footage. Its exact spot on the map is unverified until players confirm it in-game after launch.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Location", name: "Paradise Garage", category: "Storage facility", description: "A storage garage spotted in official trailer footage. Its exact spot on the map is unverified until players confirm it in-game after launch.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Location", name: "Electric Fang Tattoo", category: "Tattoo shop", description: "A tattoo parlour with a glowing fang sign, spotted in official trailer footage. Its exact spot on the map is unverified until players confirm it in-game after launch.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Character", name: "Andrés de León", category: "Supporting", description: "A supporting character reported from official GTA VI material coverage. Only Jason and Lucia are confirmed protagonists — treat every other detail as unconfirmed until Rockstar publishes more.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page (check the cast there)", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Character", name: "Bae-Luxe", category: "Supporting", description: "A supporting character reported from official GTA VI material coverage. Only Jason and Lucia are confirmed protagonists — treat every other detail as unconfirmed until Rockstar publishes more.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page (check the cast there)", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Character", name: "Boobie Ike", category: "Supporting", description: "A supporting character reported from official GTA VI material coverage. Only Jason and Lucia are confirmed protagonists — treat every other detail as unconfirmed until Rockstar publishes more.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page (check the cast there)", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Character", name: "Dre'quan Priest", category: "Supporting", description: "A supporting character reported from official GTA VI material coverage. Only Jason and Lucia are confirmed protagonists — treat every other detail as unconfirmed until Rockstar publishes more.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page (check the cast there)", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Character", name: "Kenton", category: "Supporting", description: "A supporting character reported from official GTA VI material coverage. Only Jason and Lucia are confirmed protagonists — treat every other detail as unconfirmed until Rockstar publishes more.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page (check the cast there)", sourceUrl: "https://www.rockstargames.com/VI" },
        { kind: "Character", name: "Lori Heder", category: "Supporting", description: "A supporting character reported from official GTA VI material coverage. Only Jason and Lucia are confirmed protagonists — treat every other detail as unconfirmed until Rockstar publishes more.", status: "Reported", sourceName: "Rockstar Games — official GTA VI page (check the cast there)", sourceUrl: "https://www.rockstargames.com/VI" },
      ];
      const managedCatalog = [...protagonists, ...catalog];
      const dbKey = (kind: string, name: string) => `${kind}:${name.toLowerCase()}`;
      const managedByKey = new Map(managedCatalog.map((c) => [dbKey(c.kind, c.name), c]));
      for (const row of existingDb) {
        const c = managedByKey.get(dbKey(row.kind, row.name));
        if (!c) {
          // Auto-discovered entries (added by refreshDbEntries
          // when something new appeared) are NOT catalog rows —
          // the reconcile must never delete them, or the
          // Database could never grow on its own.
          if (row.autoDiscovered === 1) continue;
          await db.delete(schema.dbRatings).where(eq(schema.dbRatings.entryId, row.id));
          await db.delete(schema.dbEntries).where(eq(schema.dbEntries.id, row.id));
          dbRemoved += 1;
          continue;
        }
        const featured = "featured" in c ? c.featured : 0;
        const drivetrain = "drivetrain" in c ? c.drivetrain ?? "" : "";
        if (
          row.category !== c.category || row.description !== c.description || row.status !== c.status ||
          row.sourceName !== c.sourceName || row.sourceUrl !== c.sourceUrl ||
          row.type !== (c.type ?? "") || row.manufacturer !== (c.manufacturer ?? "") || row.featured !== featured ||
          row.drivetrain !== drivetrain
        ) {
          await db
            .update(schema.dbEntries)
            .set({
              category: c.category, description: c.description, status: c.status,
              sourceName: c.sourceName, sourceUrl: c.sourceUrl,
              type: c.type ?? "", manufacturer: c.manufacturer ?? "", drivetrain, featured,
              updatedAt: new Date(),
            })
            .where(eq(schema.dbEntries.id, row.id));
          dbUpdated += 1;
        }
      }
      const existingKeys = new Set(existingDb.map((r) => dbKey(r.kind, r.name)));
      for (const c of managedCatalog) {
        if (existingKeys.has(dbKey(c.kind, c.name))) continue;
        await db.insert(schema.dbEntries).values({
          kind: c.kind,
          name: c.name,
          category: c.category,
          description: c.description,
          status: c.status,
          sourceName: c.sourceName,
          sourceUrl: c.sourceUrl,
          featured: "featured" in c ? c.featured : 0,
          type: c.type ?? "",
          manufacturer: c.manufacturer ?? "",
          drivetrain: "drivetrain" in c ? c.drivetrain ?? "" : "",
        });
        dbAdded += 1;
      }
      await setMeta(ctx, "last_db_sync_at", new Date().toISOString());
      let guidesAdded = 0;
      const existingGuides = await db.select().from(schema.guides);
      if (!existingGuides.some((g) => g.author === "ViceSunshine Guides")) {
        const OFFICIAL = "Official GTA VI page: https://www.rockstargames.com/VI";
        const guides: { title: string; category: string; body: string }[] = [
          {
            title: "Start here — your first day in Leonida (beginner guide)",
            category: "Beginner",
            body: `New to GTA VI? Work through this in order and you will start clean, with nothing missed.

1. Finish the install and leave space. GTA VI launched November 19, 2026 on PS5 and Xbox Series X|S only (no PC date announced). Pre-load opened November 10 — if you are installing today, keep well over 200 GB free to be safe and let the install fully finish before starting.
2. Play the opening on the default settings first. The story introduces both protagonists — Jason Duval and Lucia Caminos, the two playable leads Rockstar has officially shown. Learn how switching, driving and wanted levels feel before you change anything.
3. Then tune the basics (see the Settings guide): subtitles ON, camera and aim sensitivity to taste, and a brightness level where night scenes stay readable.
4. Save early, save often, use more than one slot. Keep one save before big story choices so you can always go back.
5. GTA VI is single-player at launch — Rockstar has not announced GTA VI Online. Everything in this guide is about the story mode; community car meets and events in ViceSunshine are community-organised, not in-game multiplayer.
6. Track your playthrough in ViceSunshine: follow the mission guides in Guides as you finish them, and check the Database before you believe any "confirmed" claim online — every entry there carries a status.

${OFFICIAL} — if anything you read anywhere disagrees with Rockstar's own page, trust Rockstar's page.`,
          },
          {
            title: "How to make money at launch — honestly, without scams",
            category: "Money",
            body: `Launch week is when fake money advice spreads fastest, so here is the honest version first: there is no verified money glitch, and nobody can sell you GTA$ for the story mode. Any site or video promising a working "money glitch", a free download, or asking for your account login is a scam — report it in the Feed and move on.

How money actually works at the start:
1. Story missions are your first income. Play the opening missions instead of grinding — they pay, they unlock the map and systems, and they teach you the economy as it opens up.
2. Do side activities as they appear. Strangers, odd jobs and world activities you discover while exploring are the game's built-in side income — when you find one that pays well, share it in Guides with what it actually paid.
3. Spend on capability first: a reliable car you like driving and the weapons you actually use beat a garage of novelties in week one.
4. Keep a cash cushion. Fines, hospital bills and mission prep eat money in GTA games — do not spend your last dollar on paint.
5. As the community verifies real methods (a repeatable activity, a good payout route), they will be added to this guide with the payout seen in-game. Until a method is verified by players after launch, treat it as a rumour.

Vice Credits in ViceSunshine are separate: they are this community's own currency, earned from activity inside ViceSunshine — they are not GTA VI money and can never buy in-game cash.`,
          },
          {
            title: "Best vehicles to start with — what is actually confirmed",
            category: "Vehicles",
            body: `Every "fastest car in GTA VI" list published before players could test the cars is a guess. Here is how to choose well with what is actually known.

What is confirmed: the trailers show a wide mix of muscle cars, sports cars, trucks, boats and aircraft in Vice City and across Leonida. The ViceSunshine Database lists vehicles with honest statuses — "Confirmed in trailer" only when a car is clearly shown in official trailer footage.

What is NOT confirmed: the muscle cars many players know from GTA V — Buccaneer, Chino, Deviant, Dominator and the rest — are labelled in the Database "Returning from GTA V — NOT confirmed for GTA VI" until they are seen in GTA VI itself. Do not plan a garage around them yet.

Choosing your first cars in-game:
1. Keep the story cars. Early missions hand you vehicles matched to the job — use them and learn how VI's driving feels before buying anything.
2. Pick one reliable all-rounder first: good brakes and grip beat top speed on Vice City streets.
3. Test before you commit: if the game lets you drive it in a mission or find it parked, drive it for five minutes before spending on it.
4. As players verify performance in-game after launch, this guide and the Database ratings (1–5, from real players) will be updated with what actually holds up.

See every vehicle and its status in the Database → Vehicles. ${OFFICIAL}`,
          },
          {
            title: "Weapons at launch — confirmed, reported and unverified",
            category: "Weapons",
            body: `Weapon information is where rumours travel fastest, so ViceSunshine labels everything. Read the Database status before you repeat a claim:
• Confirmed in trailer — clearly seen in official Rockstar trailer footage.
• Reported — named by reporting, not yet seen clearly.
• Unverified — talked about, with nothing solid behind it yet.
• Returning from GTA V — existed in GTA V; NOT confirmed for GTA VI.

The honest launch picture: trailers confirm a modern arsenal exists around Jason and Lucia's story, but full weapon lists, stats and rankings circulating online are not verified until players can test them in-game.

Getting started in-game:
1. Use what the story gives you first — early missions equip you for the job and teach the gunplay.
2. Learn one weapon of each class you actually use (a pistol, a long gun) instead of spreading money across everything.
3. Check the Database → Weapons before a big purchase decision: ratings there come from ViceSunshine players after they have used the weapon in-game.
4. The Database is maintained by the ViceSunshine team from official sources — players cannot add or edit entries, so nothing unverified slips in dressed as fact. If you spot an error, tell us through Ask Vice and a human will check it against the official source.

${OFFICIAL}`,
          },
          {
            title: "Story missions — a spoiler-safe walkthrough approach",
            category: "Missions",
            body: `This is a walkthrough approach, not a spoiler dump: how to get through GTA VI's story missions smoothly, and how ViceSunshine helps, without ruining anything for anyone.

Before a mission:
1. Arrive equipped — health, armour if the game offers it, and the weapons you are best with. Missions rarely reward showing up empty.
2. Keep a separate save slot before starting a big story beat. If a choice or an outcome bothers you, you can replay it.
3. Read the mission's guide in the Guides section first (the Missions category): each mission guide carries its official source link and, where one exists, a video guide — open it after your first attempt, not before, if you want the discovery yourself.

During a mission:
4. Play the objective, not the clock, on your first run. Most failed attempts come from rushing a section the game wanted you to approach slowly.
5. Stuck on the same section three times? Change one thing — position, weapon, or approach route — before trying a fourth. Then check the mission's guide video.
6. When you finish it, move on to the next mission's guide in Guides — and post your best moment from it to the Feed.

After the story opens up:
7. Replay missions from the menu if you want better results or missed details — and help the next player: share tips under the mission's guide instead of spoiling them in the Feed. Mark spoilers clearly, always.`,
          },
          {
            title: "Leonida map & locations — what the trailers actually showed",
            category: "Map & Locations",
            body: `First, the honest part: Rockstar has NOT released the official GTA VI map. Any "full map" image online is a fan reconstruction from trailer frames — sometimes impressive, never official. The ViceSunshine Map is labelled the same way: a fan-made concept schematic, not official and not to scale.

Regions named in trailers and reporting so far (treat exact locations as unverified until you stand there in-game):
• Vice City — the main city, officially shown across both trailers.
• Leonida Keys — the island chain south of the city.
• Port Gellhorn — a coastal port area shown in Trailer 2 reporting.
• Ambrosia — an inland industrial area.
• Mount Kalaga National Park — the wilderness and mountain region.

How to explore well:
1. Let the story open the map. Early missions are a guided tour — the game shows you the regions in an order that makes them stick.
2. When you verify a location in-game (a shop, a safehouse, a collectible), that is when it becomes real information — ViceSunshine's interactive pins open after launch for exactly this, so nothing unverified is ever pinned as fact.
3. Screenshots help everyone: post your finds in the Feed as Easter Egg Finds or Gameplay with the region named, and report secrets in Easter Eggs with the approximate region — they start as Reported and are verified by the community.

${OFFICIAL} — Rockstar's page is the only source that can confirm a location before you visit it yourself.`,
          },
          {
            title: "Tips & tricks — 12 things that help from hour one",
            category: "Tips & Tricks",
            body: `1. Subtitles on from the start — Leonida is loud, and story lines land better when you catch every word.
2. Make three save slots on day one: rotating autosave backup, pre-mission, and a "clean" early save.
3. Learn the wanted system gently: early on, somewhere quiet, see how police respond at low stars and how escaping line-of-sight works in VI specifically — it is not identical to GTA V.
4. Drive the story cars before buying. The game teaches its driving model through mission vehicles.
5. Photograph everything. Screenshot contests and car meets run in Community Events — your best shots start as your own gallery.
6. Check the Updates page before believing a "bug": if it is real and known, it will be tracked there with its status — and patch notes are only ever what Rockstar published ("No official patch notes published" means exactly that).
7. Found a secret? Report it in Easter Eggs with the approximate region. It starts as Reported — that honesty is what makes the verified ones worth trusting.
8. Join a crew early. Community Events are hosted by crew Leaders (crews with 10+ members), and crew members see private events the public list never shows.
9. Find events by hashtag: #carmeet, #race, #timetrial and #screenshot in Events search find your thing faster than scrolling.
10. Private event? The host's invite code is the key — enter it under "Joining a private event?" on the Events page, or open the invite link they sent.
11. Set your status from your profile (Add Status) or Settings — Online, Idle, Do Not Disturb or Invisible, plus a custom status — so friends know when you are actually around.
12. Verify before you share: the official Rockstar link sits at the top of the Feed for a reason. Rumours labelled as rumours are fine — rumours dressed as facts are not.`,
          },
          {
            title: "Settings to change first — PS5 & Xbox",
            category: "Settings",
            body: `Menus differ slightly between PS5 and Xbox Series X|S, and some options only appear once the game is installed — treat this as a checklist of what to look for, in order.

1. Display mode: if the game offers Performance / Quality (Fidelity) modes, start on Performance for smoother driving and aiming; switch to Quality later for screenshots if you prefer it.
2. HDR and brightness: calibrate in the console's own system settings first, then use the in-game brightness slider so neon nights stay dark but readable.
3. Subtitles: ON, with speaker names if offered — story-heavy game, busy audio mix.
4. Aim and camera: try the default aim assist level for a session before changing it; then adjust horizontal/vertical sensitivity in small steps. If there is a separate vehicle camera height, raise it one notch — better traffic awareness.
5. Vibration / triggers: on PS5, adaptive triggers add driving feel; if they tire your hands in long sessions, the console settings let you soften them system-wide.
6. Audio: if you play at night, look for a night / dynamic-range setting so dialogue stays clear at low volume.
7. Controls remapping lives at console level on both systems if you need it — set it once and it applies everywhere.

Change one thing at a time and play ten minutes between changes — otherwise you never learn which setting actually helped.`,
          },
          {
            title: "Launch-day problems — what to check before you panic",
            category: "Fixes",
            body: `Most launch-day problems are boring and fixable. Work down this list before reinstalling anything.

1. Install not finishing or stuck: check free space first (keep well over 200 GB free), then the console's download queue — a paused system update can block a game install. Restart the console, not just the game.
2. "Content not ready" on a code-in-box edition: the physical edition is a code in a box — the full download still has to finish. The disc/code does not contain the game.
3. Game will not start after installing: fully close it, restart the console, and check for a day-one patch in the Updates page here — ViceSunshine lists patches with their real status, and "No official patch notes published" means Rockstar has not published notes yet, not that no patch exists.
4. Performance feels off: try the other display mode (Performance vs Quality) if offered, and make sure your TV is on its game mode input setting.
5. Something is genuinely broken in-game: report it in Bugs with your platform (PS5 / Xbox) and what you were doing — the tracker shows whether others have confirmed it and whether a workaround exists. Votes and confirmations there are real community reports, not guesses.
6. Still stuck? Ask Vice (the button on every page) — it answers from ViceSunshine's own pages, and for account problems it opens a support request a human reviews.

Never download "fixes", "cracks" or mod menus from outside the console stores — on PS5 and Xbox there is no legitimate version of any of them, and they are the oldest scam in gaming.`,
          },
        ];
        for (const g of guides) {
          await db.insert(schema.guides).values({ title: g.title, category: g.category, body: g.body, author: "ViceSunshine Guides" });
          guidesAdded += 1;
        }
      }
      ctx.invalidateQueries();
      return { feedAdded, eventsAdded, dbAdded, dbUpdated, dbRemoved, guidesAdded };
    },
  }),

  listDbEntries: defineAction({
    description: "Lists the GTA VI Database (Vehicles, Weapons, Characters, Locations). Every entry carries a verification status — Confirmed in trailer only when clearly shown in an official Rockstar trailer or news post with the source linked; everything else is Reported, Unverified or Returning from GTA V.",
    request: z.object({
      kind: z.string().max(20).default("All"),
      search: z.string().max(80).default(""),
      playerKey: z.string().max(80).default(""),
    }),
    response: z.object({
      items: z.array(
        z.object({
          id: z.number(),
          kind: z.string(),
          name: z.string(),
          category: z.string(),
          description: z.string(),
          status: z.string(),
          sourceName: z.string(),
          sourceUrl: z.string(),
          featured: z.boolean(),
          type: z.string(),
          manufacturer: z.string(),
          drivetrain: z.string(),
          ratingAvg: z.number(),
          ratingCount: z.number(),
          myRating: z.number(),
          imageUrl: z.string(),
          updatedAt: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let rows = await db.select().from(schema.dbEntries).orderBy(desc(schema.dbEntries.updatedAt));
      const ratings = await db.select().from(schema.dbRatings);
      if (args.kind !== "All") rows = rows.filter((r) => r.kind === args.kind);
      const q = args.search.trim().toLowerCase();
      if (q) {
        rows = rows.filter(
          (r) =>
            r.name.toLowerCase().includes(q) || r.category.toLowerCase().includes(q) ||
            r.manufacturer.toLowerCase().includes(q) || r.type.toLowerCase().includes(q),
        );
      }
      const items = await Promise.all(
        rows.map(async (r) => {
          const rs = ratings.filter((x) => x.entryId === r.id);
          return {
            id: r.id,
            kind: r.kind,
            name: r.name,
            category: r.category,
            description: r.description,
            status: r.status,
            sourceName: r.sourceName,
            sourceUrl: r.sourceUrl,
            featured: r.featured === 1,
            type: r.type,
            manufacturer: r.manufacturer,
            drivetrain: r.drivetrain,
            ratingAvg: rs.length ? Math.round((rs.reduce((a, x) => a + x.rating, 0) / rs.length) * 10) / 10 : 0,
            ratingCount: rs.length,
            myRating: rs.find((x) => x.playerKey === args.playerKey)?.rating ?? 0,
            imageUrl: r.imageBlobKey ? await ctx.blobs.getUrl(r.imageBlobKey) : "",
            updatedAt: r.updatedAt.toISOString(),
          };
        }),
      );
      return { items };
    },
  }),

  seedDbArt: defineAction({
    description: "Generates original ViceSunshine illustrations for Database entries that do not have artwork yet (one specific picture per vehicle, weapon, character or location — an original fan illustration drawn identical to the real GTA VI item itself, same shape, colours and details, on ViceSunshine's own background; never copied screenshots or official artwork). Processes a limited batch per call; call again until remaining is 0.",
    request: z.object({ limit: z.number().int().min(1).max(40).default(8) }),
    response: z.object({ generated: z.number(), remaining: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      // Round-robin across kinds (Weapons first — a whole weapon class
      // sat on letter tiles while vehicles painted ahead of it), so
      // every section of the Database gains its real pictures evenly
      // and no kind is ever left showing a placeholder.
      const kindRank = (k: string) => (k === "Weapon" ? 0 : k === "Vehicle" ? 1 : k === "Character" ? 2 : 3);
      const missingAll = (await db.select().from(schema.dbEntries)).filter((r) => !r.imageBlobKey);
      const byKind = new Map<string, typeof missingAll>();
      for (const r of missingAll) {
        const list = byKind.get(r.kind) ?? [];
        list.push(r);
        byKind.set(r.kind, list);
      }
      for (const list of byKind.values()) list.sort((a, b) => a.id - b.id);
      const kinds = [...byKind.keys()].sort((a, b) => kindRank(a) - kindRank(b));
      const missing: typeof missingAll = [];
      for (let round = 0; missing.length < missingAll.length; round++) {
        let added = false;
        for (const k of kinds) {
          const item = byKind.get(k)?.[round];
          if (item) { missing.push(item); added = true; }
        }
        if (!added) break;
      }
      const batch = missing.slice(0, args.limit);
      let generated = 0;
      for (const entry of batch) {
        if (await generateDbArtFor(ctx, entry)) generated += 1;
      }
      const remaining = (await db.select().from(schema.dbEntries)).filter((r) => !r.imageBlobKey).length;
      return { generated, remaining };
    },
  }),

  seedAvatarArt: defineAction({
    description: "Generates the original ViceSunshine avatar character illustrations (the 5 free avatars plus the 3 Premium-exclusive avatars — Neon Outlaw, Alien Visitor, Supercar Ace) for the Customise section's avatars. Idempotent — only missing avatars are generated.",
    request: z.object({}),
    response: z.object({ generated: z.number(), total: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.meta);
      const have = new Set(rows.filter((r) => r.key.startsWith("avatar-art:") && r.value).map((r) => r.key.slice("avatar-art:".length)));
      let generated = 0;
      for (const def of AVATAR_DEFS) {
        if (have.has(def.id)) continue;
        try {
          const media = await ctx.tool.generate_media(
            `Paint ${def.spec}. An original ViceSunshine avatar character in a neon Vice City style — the vibe is GTA-like street culture, but the character is entirely original, not copied from any game or artwork. ${AVATAR_ART_STYLE}`,
            { key: `avatar-art/${def.id}`, orientation: "portrait" },
          );
          await db
            .insert(schema.meta)
            .values({ key: `avatar-art:${def.id}`, value: media.blobKey })
            .onConflictDoUpdate({ target: schema.meta.key, set: { value: media.blobKey } });
          generated += 1;
        } catch { /* retried on a later call */ }
      }
      return { generated, total: AVATAR_DEFS.length };
    },
  }),

  seedArtwork: defineAction({
    description: "Artwork maintenance: generates a small batch of missing Database entry illustrations, any missing avatar illustrations, and the current season's auto-generated calling card artwork (one per run — a new season's set generates itself on this schedule, at a higher design tier every season). Runs on a schedule until everything has original ViceSunshine artwork; safe to call any time.",
    request: z.object({}),
    response: z.object({ dbGenerated: z.number(), avatarGenerated: z.number(), dbRemaining: z.number(), seasonCardGenerated: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const all = await db.select().from(schema.dbEntries);
      const missing = all.filter((r) => !r.imageBlobKey);
      // Artwork v3 (realism + distinct pass): every entry that already
      // has art is regenerated exactly once with the near-photoreal
      // game-render style and its own distinct per-entry spec —
      // vehicles first, so no two cars share a look and nothing is a
      // repaint of the same car from another angle. Tracked per entry
      // in meta; entries painted fresh already use the v3 prompts, so
      // they are marked done as they generate.
      let v3Ids = new Set<number>();
      try {
        v3Ids = new Set(JSON.parse((await getMeta(ctx, "db_art_v3_ids")) || "[]") as number[]);
      } catch {
        v3Ids = new Set<number>();
      }
      // Character redo (owner's direction): every character portrait
      // is repainted exactly once with the new GTA game-render specs
      // — same face, same hair, same signature outfit, same GTA
      // graphics style, as original fan illustrations — tracked in
      // meta db_art_char2_ids. Runs after missing pictures and
      // before the general v3 repaint queue.
      let char2Ids = new Set<number>();
      try {
        char2Ids = new Set(JSON.parse((await getMeta(ctx, "db_art_char2_ids")) || "[]") as number[]);
      } catch {
        char2Ids = new Set<number>();
      }
      const charPending = all
        .filter((r) => r.kind === "Character" && r.imageBlobKey && !char2Ids.has(r.id))
        .sort((a, b) => a.id - b.id);
      // Artwork v4 (TRN framing + facial fidelity pass): every
      // entry that already has art is repainted exactly once with
      // the v4 framing rules in generateDbArtFor — vehicles
      // in-world at varied angles, weapons as flat cut-outs,
      // characters with the face in the upper third and the
      // mandatory fidelity rule (no invented features — no beard
      // where the character has none), locations as wide
      // eye-level exteriors — tracked in meta db_art_v4_ids.
      let v4Ids = new Set<number>();
      try {
        v4Ids = new Set(JSON.parse((await getMeta(ctx, "db_art_v4_ids")) || "[]") as number[]);
      } catch {
        v4Ids = new Set<number>();
      }
      // Artwork v5 (identical-item pass, owner's Duke 556 example):
      // every entry that already has art is repainted exactly once
      // with the v5 brief — the item drawn identical to the real
      // GTA VI item (same shape, proportions, factory colours,
      // details; no neon, no glow, no sci-fi restyling on the item)
      // on ViceSunshine's unchanged backgrounds, with the corrected
      // per-entry specs (the 556 is an M16-pattern rifle, not a
      // bullpup). Tracked in meta db_art_v5_ids; runs after missing
      // pictures and the character queue, before the older v4 / v3
      // queues (anything v5 paints is also marked v4 / v3 done).
      let v5Ids = new Set<number>();
      try {
        v5Ids = new Set(JSON.parse((await getMeta(ctx, "db_art_v5_ids")) || "[]") as number[]);
      } catch {
        v5Ids = new Set<number>();
      }
      const kindRank = (k: string) => (k === "Weapon" ? 0 : k === "Vehicle" ? 1 : k === "Character" ? 2 : 3);
      const v5Pending = all
        .filter((r) => r.imageBlobKey && !v5Ids.has(r.id))
        .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.id - b.id);
      const v4Pending = all
        .filter((r) => r.imageBlobKey && !v4Ids.has(r.id))
        .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.id - b.id);
      const v3Pending = all
        .filter((r) => r.imageBlobKey && !v3Ids.has(r.id))
        .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.id - b.id);
      // Missing pictures ALWAYS come first: while any entry has no
      // picture at all, repaints wait — an entry with no art is worse
      // than an entry with older art. Missing entries are interleaved
      // across kinds so Weapons, Vehicles, Characters and Locations
      // all complete together.
      const missingByKind = new Map<string, typeof missing>();
      for (const r of missing) {
        const list = missingByKind.get(r.kind) ?? [];
        list.push(r);
        missingByKind.set(r.kind, list);
      }
      for (const list of missingByKind.values()) list.sort((a, b) => a.id - b.id);
      const missingKinds = [...missingByKind.keys()].sort((a, b) => kindRank(a) - kindRank(b));
      const missingInterleaved: typeof missing = [];
      for (let round = 0; missingInterleaved.length < missing.length; round++) {
        let added = false;
        for (const k of missingKinds) {
          const item = missingByKind.get(k)?.[round];
          if (item) { missingInterleaved.push(item); added = true; }
        }
        if (!added) break;
      }
      // Queue order: missing pictures first, then the v5
      // identical-item repaint (weapons first — the 556 is the
      // owner's test case), then the older character / v4 / v3
      // queues. v5 used to sit BEHIND the character queue, so a
      // fresh v5 build could wait behind older passes before a
      // single weapon changed.
      const queue = missing.length > 0 ? missingInterleaved : v5Pending.length > 0 ? v5Pending : charPending.length > 0 ? charPending : v4Pending.length > 0 ? v4Pending : v3Pending;
      let dbGenerated = 0;
      for (const entry of queue.slice(0, 12)) {
        if (await generateDbArtFor(ctx, entry)) {
          dbGenerated += 1;
          v3Ids.add(entry.id);
          v4Ids.add(entry.id);
          v5Ids.add(entry.id);
          if (entry.kind === "Character") char2Ids.add(entry.id);
          // Save progress after EVERY successful repaint, not once
          // at the end of the batch: a run that is cut short mid-
          // batch used to lose the whole batch's bookkeeping, so
          // finished repaints were painted again and the queue
          // looked frozen.
          await setMeta(ctx, "db_art_v3_ids", JSON.stringify([...v3Ids]));
          await setMeta(ctx, "db_art_v4_ids", JSON.stringify([...v4Ids]));
          await setMeta(ctx, "db_art_v5_ids", JSON.stringify([...v5Ids]));
          await setMeta(ctx, "db_art_char2_ids", JSON.stringify([...char2Ids]));
        }
      }
      const rows = await db.select().from(schema.meta);
      const have = new Set(rows.filter((r) => r.key.startsWith("avatar-art:") && r.value).map((r) => r.key.slice("avatar-art:".length)));
      let avatarGenerated = 0;
      for (const def of AVATAR_DEFS) {
        if (have.has(def.id)) continue;
        try {
          const media = await ctx.tool.generate_media(
            `Paint ${def.spec}. An original ViceSunshine avatar character in a neon Vice City style — the vibe is GTA-like street culture, but the character is entirely original, not copied from any game or artwork. ${AVATAR_ART_STYLE}`,
            { key: `avatar-art/${def.id}`, orientation: "portrait" },
          );
          await db
            .insert(schema.meta)
            .values({ key: `avatar-art:${def.id}`, value: media.blobKey })
            .onConflictDoUpdate({ target: schema.meta.key, set: { value: media.blobKey } });
          avatarGenerated += 1;
        } catch { /* retried on a later run */ }
      }
      // Season calling cards auto-generate here: one missing card
      // from the CURRENT season's set per run, so when a new season
      // starts its whole set paints itself over the first runs of
      // the month — no manual step, and each season's brief is a
      // higher design tier than the last.
      let seasonCardGenerated = 0;
      {
        const seasonNum = seasonNumberOfKey(seasonKeyOf(new Date()));
        const haveSeasonArt = new Set(
          rows.filter((r) => r.key.startsWith("season-card-art:") && r.value).map((r) => r.key.slice("season-card-art:".length)),
        );
        const missingDef = seasonChallengesOf(seasonNum).find((def) => !haveSeasonArt.has(seasonCardValue(seasonNum, def.metric)));
        if (missingDef && (await generateSeasonCardArtFor(ctx, seasonNum, missingDef))) {
          seasonCardGenerated = 1;
          await setMeta(ctx, "last_season_cards_refresh_at", new Date().toISOString());
        }
      }
      const dbRemaining = (await db.select().from(schema.dbEntries)).filter((r) => !r.imageBlobKey).length;
      return { dbGenerated, avatarGenerated, dbRemaining, seasonCardGenerated };
    },
  }),

  repaintDbEntry: defineAction({
    description: "Repaints ONE Database entry's picture right now with the current identical-item brief (the entry drawn identical to the real GTA VI item — same shape, proportions, factory colours and details, no neon or sci-fi restyling — on ViceSunshine's unchanged background), under a fresh versioned picture URL so the new art actually displays, and marks the entry done in every repaint queue. Used to fix a named entry (the Duke 556 first) without waiting for the batch schedule.",
    request: z.object({ entryId: z.number().int().positive() }),
    response: z.object({ ok: z.boolean(), name: z.string(), imageUrl: z.string(), error: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const entry = (await db.select().from(schema.dbEntries).where(eq(schema.dbEntries.id, args.entryId)))[0];
      if (!entry) return { ok: false, name: "", imageUrl: "", error: "No Database entry with that id." };
      const painted = await generateDbArtFor(ctx, entry);
      if (!painted) {
        let message = "Picture generation failed.";
        try {
          const rec = JSON.parse((await getMeta(ctx, "db_art_last_error")) || "{}") as { message?: string };
          if (rec.message) message = rec.message;
        } catch { /* keep the generic message */ }
        return { ok: false, name: entry.name, imageUrl: "", error: message };
      }
      const loadIds = async (key: string): Promise<Set<number>> => {
        try {
          return new Set(JSON.parse((await getMeta(ctx, key)) || "[]") as number[]);
        } catch {
          return new Set<number>();
        }
      };
      const [v3Ids, v4Ids, v5Ids, char2Ids] = await Promise.all([
        loadIds("db_art_v3_ids"), loadIds("db_art_v4_ids"), loadIds("db_art_v5_ids"), loadIds("db_art_char2_ids"),
      ]);
      v3Ids.add(entry.id);
      v4Ids.add(entry.id);
      v5Ids.add(entry.id);
      if (entry.kind === "Character") char2Ids.add(entry.id);
      await setMeta(ctx, "db_art_v3_ids", JSON.stringify([...v3Ids]));
      await setMeta(ctx, "db_art_v4_ids", JSON.stringify([...v4Ids]));
      await setMeta(ctx, "db_art_v5_ids", JSON.stringify([...v5Ids]));
      await setMeta(ctx, "db_art_char2_ids", JSON.stringify([...char2Ids]));
      const fresh = (await db.select().from(schema.dbEntries).where(eq(schema.dbEntries.id, entry.id)))[0];
      return {
        ok: true,
        name: entry.name,
        imageUrl: fresh?.imageBlobKey ? await ctx.blobs.getUrl(fresh.imageBlobKey) : "",
        error: "",
      };
    },
  }),

  rateDbEntry: defineAction({
    description: "Rates a Database entry 1-5 (community rating). One rating per player per entry; rating again updates it.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      entryId: z.number().int().positive(),
      rating: z.number().int().min(1).max(5),
    }),
    response: z.object({ ratingAvg: z.number(), ratingCount: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      const existing = await db
        .select()
        .from(schema.dbRatings)
        .where(and(eq(schema.dbRatings.entryId, args.entryId), eq(schema.dbRatings.playerKey, args.playerKey)));
      if (existing[0]) {
        await db.update(schema.dbRatings).set({ rating: args.rating }).where(eq(schema.dbRatings.id, existing[0].id));
      } else {
        await db.insert(schema.dbRatings).values({ entryId: args.entryId, playerKey: args.playerKey, rating: args.rating });
      }
      const rs = await db.select().from(schema.dbRatings).where(eq(schema.dbRatings.entryId, args.entryId));
      ctx.invalidateQueries();
      return {
        ratingAvg: rs.length ? Math.round((rs.reduce((a, x) => a + x.rating, 0) / rs.length) * 10) / 10 : 0,
        ratingCount: rs.length,
      };
    },
  }),

  getWallet: defineAction({
    description: "Returns the player's Vice Credits wallet: balance, ViceSunshine level, crew wallets they can see, full transaction history (Earned / Bought / Spent), and their recent automatic Rank Point activity.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({
      hasProfile: z.boolean(),
      balance: z.number(),
      startingCredits: z.number(),
      clanCreateCost: z.number(),
      vicePoints: z.number(),
      viceLevel: z.number(),
      viceNextLevelPoints: z.number(),
      viceLevelStartPoints: z.number(),
      levelMilestones: z.array(z.object({ level: z.number(), credits: z.number() })),
      tier: z.number(),
      premiumActive: z.boolean(),
      premiumWeeklyCredits: z.number(),
      premiumNextPayout: z.string(),
      premiumSince: z.string(),
      premiumEndsAt: z.string(),
      premiumNextBilling: z.string(),
      premiumPriceCad: z.string(),
      paymentsConnected: z.boolean(),
      paymentHistory: z.array(
        z.object({
          id: z.number(),
          kind: z.string(),
          label: z.string(),
          amountCad: z.string(),
          status: z.string(),
          createdAt: z.string(),
        }),
      ),
      transactions: z.array(
        z.object({
          id: z.number(),
          scope: z.string(),
          clanName: z.string(),
          amount: z.number(),
          category: z.string(),
          reason: z.string(),
          createdAt: z.string(),
        }),
      ),
      clanWallets: z.array(
        z.object({ clanId: z.number(), clanName: z.string(), walletCredits: z.number(), myRole: z.string() }),
      ),
      myPoints: z.array(
        z.object({
          id: z.number(),
          source: z.string(),
          title: z.string(),
          points: z.number(),
          clanName: z.string(),
          createdAt: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const premiumState = await applyPremiumWeeklyCredits(ctx, args.playerKey);
      const profRows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const prof = profRows[0];
      const events = await db.select().from(schema.rankPointEvents);
      const vicePoints = personalPointsOf(events, args.playerKey);
      const lvl = playerLevelFromPoints(vicePoints);
      // Pay any newly reached level milestones, then re-read the
      // profile so the returned balance includes them. The
      // transaction list below is fetched after this, so milestone
      // payouts appear in the history on the same read.
      await applyLevelMilestoneCredits(ctx, args.playerKey, lvl.level);
      const freshProfRows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const freshProf = freshProfRows[0];
      const clans = await db.select().from(schema.clans);
      const clanNameOf = (id: number) => clans.find((c) => c.id === id)?.name ?? "";
      const txs = await db
        .select()
        .from(schema.creditTransactions)
        .orderBy(desc(schema.creditTransactions.id));
      const myMemberships = await db
        .select()
        .from(schema.clanMembers)
        .where(eq(schema.clanMembers.playerKey, args.playerKey));
      const myClanIds = new Set(myMemberships.map((m) => m.clanId));
      const visibleTxs = txs.filter(
        (t) =>
          (t.scope === "personal" && t.ownerId === args.playerKey) ||
          (t.scope === "clan" && myClanIds.has(Number(t.ownerId))),
      );
      const myEvents = events
        .filter((e) => e.playerKey === args.playerKey)
        .sort((a, b) => b.id - a.id);
      const seenRefs = new Set<string>();
      const myPoints = [];
      for (const e of myEvents) {
        if (seenRefs.has(e.sourceRef)) continue;
        seenRefs.add(e.sourceRef);
        myPoints.push({
          id: e.id,
          source: e.source,
          title: e.reason,
          points: e.points,
          clanName: clanNameOf(e.clanId),
          createdAt: e.createdAt.toISOString(),
        });
        if (myPoints.length >= 50) break;
      }
      return {
        hasProfile: !!prof,
        balance: freshProf?.credits ?? prof?.credits ?? 0,
        startingCredits: STARTING_CREDITS,
        clanCreateCost: CLAN_CREATE_COST,
        vicePoints,
        viceLevel: lvl.level,
        viceNextLevelPoints: lvl.nextAt,
        viceLevelStartPoints: lvl.levelStart,
        levelMilestones: LEVEL_MILESTONES,
        tier: playerTierOf(lvl.level),
        premiumActive: premiumState.active,
        premiumWeeklyCredits: PREMIUM_WEEKLY_CREDITS,
        premiumNextPayout: premiumState.nextPayoutAt,
        premiumSince: premiumState.sinceAt,
        premiumEndsAt: premiumState.endsAt,
        premiumNextBilling: premiumState.nextBillingAt,
        premiumPriceCad: PREMIUM_PRICE_CAD,
        // Payments are not connected yet (Stripe comes later, on the
        // owner's account): no money has ever moved through ViceSunshine,
        // so the payment history is honestly empty. When Stripe is
        // connected, real charges / refunds will be recorded and listed
        // here; weekly credit grants already appear in `transactions`.
        paymentsConnected: false,
        paymentHistory: [],
        transactions: visibleTxs.slice(0, 100).map((t) => ({
          id: t.id,
          scope: t.scope,
          clanName: t.scope === "clan" ? clanNameOf(Number(t.ownerId)) : "",
          amount: t.amount,
          category: t.amount < 0 ? "Spent" : /bought|purchase/i.test(t.reason) ? "Bought" : "Earned",
          reason: t.reason,
          createdAt: t.createdAt.toISOString(),
        })),
        clanWallets: myMemberships.map((m) => ({
          clanId: m.clanId,
          clanName: clanNameOf(m.clanId),
          walletCredits: clans.find((c) => c.id === m.clanId)?.walletCredits ?? 0,
          myRole: m.role,
        })),
        myPoints,
      };
    },
  }),

  hostConfirmEvent: defineAction({
    description: "The hosting crew's Leader confirms the whole event result in one tap: pick 1st / 2nd / 3rd from the players who RSVP'd. Winners earn +50 / +30 / +20 Rank Points automatically, and — Event Rewards, separate from Crew Awards — the winners' crews get Vice Credits in the crew wallet (1st 150, 2nd 75, 3rd 50) while every other crew that showed up gets a +10 participation credit bonus. Attendance points (+15) are counted automatically when a player RSVPs Going. Credits are paid once per event.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      gamertag: z.string().trim().min(2).max(32),
      eventId: z.number().int().positive(),
      first: z.string().trim().max(32).default(""),
      second: z.string().trim().max(32).default(""),
      third: z.string().trim().max(32).default(""),
    }),
    response: z.object({ confirmed: z.number(), skipped: z.array(z.string()), clanCreditsPaid: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const evRows = await db.select().from(schema.events).where(eq(schema.events.id, args.eventId));
      const ev = evRows[0];
      if (!ev) throw new Error("Event not found.");
      if (!(await isEventManager(ctx, ev, args.playerKey, args.gamertag))) {
        throw new Error("Only the Leader of the hosting crew can confirm the results.");
      }
      const profs = await db.select().from(schema.profiles);
      const byTag = new Map(profs.map((pr) => [pr.gamertag.toLowerCase(), pr]));
      const skipped: string[] = [];
      let confirmed = 0;
      const places: { tag: string; place: number; points: number }[] = [
        { tag: args.first, place: 1, points: POINT_RATES.eventWin[0] },
        { tag: args.second, place: 2, points: POINT_RATES.eventWin[1] },
        { tag: args.third, place: 3, points: POINT_RATES.eventWin[2] },
      ];
      for (const pl of places) {
        if (!pl.tag) continue;
        const winner = byTag.get(pl.tag.toLowerCase());
        if (!winner) { skipped.push(pl.tag); continue; }
        const did = await recordPoints(ctx, {
          playerKey: winner.playerKey,
          gamertag: winner.gamertag,
          targetClanId: null,
          source: "event-win",
          sourceRef: `event-win:${ev.id}:${pl.place}`,
          reason: `Placed ${pl.place === 1 ? "1st" : pl.place === 2 ? "2nd" : "3rd"} at community event: ${ev.title}`,
          points: pl.points,
          verifiedBy: `Event host ${args.gamertag}`,
        });
        if (did) confirmed += 1;
      }
      // Event Rewards (Vice Credits) — separate from Clan
      // Awards. Winners' clans are paid into the clan wallet; every
      // other clan with a member who RSVP'd Going gets a small
      // participation bonus. Paid once per event: the [event:<id>:…]
      // tag in the credit log is the guard.
      let clanCreditsPaid = 0;
      if (confirmed > 0) {
        const txs = await db.select().from(schema.creditTransactions);
        const alreadyPaid = (tag: string) => txs.some((t) => t.reason.includes(`[event:${ev.id}:${tag}]`));
        const allMembers = await db.select().from(schema.clanMembers);
        const clanOfPlayer = (playerKey: string) => allMembers.find((m) => m.playerKey === playerKey)?.clanId ?? 0;
        const payClan = async (clanId: number, amount: number, label: string, tag: string) => {
          if (clanId <= 0 || alreadyPaid(tag)) return;
          const rows = await db.select().from(schema.clans).where(eq(schema.clans.id, clanId));
          const c = rows[0];
          if (!c) return;
          await db.update(schema.clans).set({ walletCredits: c.walletCredits + amount }).where(eq(schema.clans.id, clanId));
          await logCredit(ctx, "clan", String(clanId), args.playerKey, amount, `${label} [event:${ev.id}:${tag}]`);
          clanCreditsPaid += amount;
        };
        const winnerClanIds = new Set<number>();
        const placeCredits = [150, 75, 50];
        for (const pl of places) {
          if (!pl.tag) continue;
          const winner = byTag.get(pl.tag.toLowerCase());
          if (!winner) continue;
          const clanId = clanOfPlayer(winner.playerKey);
          if (clanId > 0) {
            winnerClanIds.add(clanId);
            await payClan(clanId, placeCredits[pl.place - 1] ?? 0, `Event Reward — ${pl.place === 1 ? "1st" : pl.place === 2 ? "2nd" : "3rd"} place crew award in Vice Credits: ${ev.title}`, `win${pl.place}`);
          }
        }
        const evRsvps = await db.select().from(schema.rsvps).where(eq(schema.rsvps.eventId, ev.id));
        const participantClans = new Set<number>();
        for (const r of evRsvps) {
          if (r.status !== "Going") continue;
          const clanId = clanOfPlayer(r.playerKey);
          if (clanId > 0 && !winnerClanIds.has(clanId)) participantClans.add(clanId);
        }
        for (const clanId of participantClans) {
          await payClan(clanId, 10, `Event Reward — participation bonus: ${ev.title}`, `part${clanId}`);
        }
        await db.update(schema.events).set({
          results: ev.results || `Host-confirmed results: 1st ${args.first}${args.second ? ` · 2nd ${args.second}` : ""}${args.third ? ` · 3rd ${args.third}` : ""}`,
        }).where(eq(schema.events.id, ev.id));
      }
      ctx.invalidateQueries();
      return { confirmed, skipped, clanCreditsPaid };
    },
  }),

  listClanPoints: defineAction({
    description: "Lists a crew's automatic Rank Point entries (newest first): who earned them, from which in-app action, how many, and when — with report counts.",
    request: z.object({ clanId: z.number().int().positive() }),
    response: z.object({
      items: z.array(
        z.object({
          id: z.number(),
          gamertag: z.string(),
          source: z.string(),
          title: z.string(),
          points: z.number(),
          verifiedBy: z.string(),
          reports: z.number(),
          createdAt: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const events = await db
        .select()
        .from(schema.rankPointEvents)
        .where(eq(schema.rankPointEvents.clanId, args.clanId))
        .orderBy(desc(schema.rankPointEvents.id));
      const reports = await db.select().from(schema.activityReports);
      return {
        items: events.slice(0, 100).map((e) => ({
          id: e.id,
          gamertag: e.gamertag,
          source: e.source,
          title: e.reason,
          points: e.points,
          verifiedBy: e.verifiedBy,
          reports: reports.filter((r) => r.eventId === e.id).length,
          createdAt: e.createdAt.toISOString(),
        })),
      };
    },
  }),

  reportActivity: defineAction({
    description: "Reports a Rank Point entry as fake or abusive. Three reports remove the entry's points from the crew (light-touch moderation — there is no Pending queue for normal points).",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      eventId: z.number().int().positive(),
      reason: z.string().trim().max(300).default(""),
    }),
    response: z.object({ reports: z.number(), removed: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.rankPointEvents)
        .where(eq(schema.rankPointEvents.id, args.eventId));
      const entry = rows[0];
      if (!entry) throw new Error("Point entry not found.");
      const existing = await db
        .select()
        .from(schema.activityReports)
        .where(
          and(
            eq(schema.activityReports.eventId, args.eventId),
            eq(schema.activityReports.reporterKey, args.playerKey),
          ),
        );
      if (!existing[0]) {
        await db.insert(schema.activityReports).values({
          eventId: args.eventId,
          reporterKey: args.playerKey,
          reason: args.reason,
        });
      }
      const all = await db
        .select()
        .from(schema.activityReports)
        .where(eq(schema.activityReports.eventId, args.eventId));
      let removed = false;
      if (all.length >= 3) {
        // Remove every clan row for the same activity instance.
        await db
          .delete(schema.rankPointEvents)
          .where(
            and(
              eq(schema.rankPointEvents.playerKey, entry.playerKey),
              eq(schema.rankPointEvents.sourceRef, entry.sourceRef),
            ),
          );
        removed = true;
      }
      ctx.invalidateQueries();
      return { reports: all.length, removed };
    },
  }),

  getSeason: defineAction({
    description: "Returns the current season (calendar month), its end date, the prize table, and past season winners.",
    request: z.object({}),
    response: z.object({
      seasonKey: z.string(),
      seasonLabel: z.string(),
      seasonEndsAt: z.string(),
      previousSeasonKey: z.string(),
      previousSeasonLabel: z.string(),
      prizes: z.array(z.object({ label: z.string(), credits: z.number() })),
      history: z.array(
        z.object({
          id: z.number(),
          seasonKey: z.string(),
          seasonLabel: z.string(),
          board: z.string(),
          clanId: z.number(),
          clanName: z.string(),
          rank: z.number(),
          seasonPoints: z.number(),
          creditsAwarded: z.number(),
          emblemAwarded: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const key = seasonKeyOf(new Date());
      const prev = previousSeasonKeyOf(key);
      const history = await db
        .select()
        .from(schema.seasonWinners)
        .orderBy(desc(schema.seasonWinners.id));
      return {
        seasonKey: key,
        seasonLabel: seasonLabelOf(key),
        seasonEndsAt: seasonEndsAtOf(key),
        previousSeasonKey: prev,
        previousSeasonLabel: seasonLabelOf(prev),
        prizes: [
          { label: "1st place (per board: Global, PlayStation, Xbox)", credits: 1000 },
          { label: "2nd place", credits: 600 },
          { label: "3rd place", credits: 300 },
          { label: "Top 10 (ranks 4–10)", credits: SEASON_TOP10_CREDITS },
        ],
        history: history.slice(0, 60).map((h) => ({
          id: h.id,
          seasonKey: h.seasonKey,
          seasonLabel: seasonLabelOf(h.seasonKey),
          board: h.board,
          clanId: h.clanId,
          clanName: h.clanName,
          rank: h.rank,
          seasonPoints: h.seasonPoints,
          creditsAwarded: h.creditsAwarded,
          emblemAwarded: h.emblemAwarded,
        })),
      };
    },
  }),

  closeSeason: defineAction({
    description: "Closes a finished season: awards Vice Credits to the winning crews' wallets on the Global, PlayStation and Xbox boards (1st 1000 + exclusive seasonal emblem, 2nd 600, 3rd 300, top 10 100) and records the winners. Seasonal points are computed per month, so the new month starts at 0 automatically — lifetime Crew Level and credits never reset.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      seasonKey: z.string().regex(/^\d{4}-\d{2}$/),
    }),
    response: z.object({ awardedClans: z.number(), totalCredits: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const current = seasonKeyOf(new Date());
      if (args.seasonKey >= current) {
        throw new Error("That season has not ended yet — seasonal awards are paid after the month closes.");
      }
      const existing = await db
        .select()
        .from(schema.seasonWinners)
        .where(eq(schema.seasonWinners.seasonKey, args.seasonKey));
      if (existing.length > 0) {
        throw new Error(`${seasonLabelOf(args.seasonKey)} has already been closed and its awards paid.`);
      }
      const stats = await computeClanRankStats(ctx, args.seasonKey);
      const clans = await db.select().from(schema.clans);
      const withStats = clans
        .map((c) => ({ clan: c, s: stats.get(c.id) ?? EMPTY_RANK }))
        .filter((x) => x.s.seasonPoints > 0);
      const sortBoard = (list: typeof withStats) =>
        [...list].sort(
          (a, b) =>
            b.s.effectiveSeasonPoints - a.s.effectiveSeasonPoints ||
            b.s.effectiveLifetimePoints - a.s.effectiveLifetimePoints ||
            a.clan.name.localeCompare(b.clan.name),
        );
      const boards: { name: string; list: typeof withStats }[] = [
        { name: "Global", list: sortBoard(withStats) },
        { name: "PlayStation", list: sortBoard(withStats.filter((x) => x.clan.platform === "PS5" || x.clan.platform === "Both")) },
        { name: "Xbox", list: sortBoard(withStats.filter((x) => x.clan.platform === "Xbox" || x.clan.platform === "Both")) },
      ];
      let awardedClans = 0;
      let totalCredits = 0;
      const paidClans = new Set<number>();
      for (const board of boards) {
        for (let i = 0; i < Math.min(10, board.list.length); i++) {
          const entry = board.list[i];
          if (!entry) continue;
          const rank = i + 1;
          const credits = rank === 1 ? 1000 : rank === 2 ? 600 : rank === 3 ? 300 : SEASON_TOP10_CREDITS;
          const fresh = await db.select().from(schema.clans).where(eq(schema.clans.id, entry.clan.id));
          const clanRow = fresh[0];
          if (!clanRow) continue;
          await db
            .update(schema.clans)
            .set({ walletCredits: clanRow.walletCredits + credits })
            .where(eq(schema.clans.id, entry.clan.id));
          await logCredit(
            ctx,
            "clan",
            String(entry.clan.id),
            args.playerKey,
            credits,
            `Season ${args.seasonKey} award — ${board.name} board, rank #${rank}`,
          );
          let emblemAwarded = "";
          if (rank === 1) {
            emblemAwarded = "Phoenix emblem (season prize)";
            const owned = await db.select().from(schema.ownedItems);
            if (!owned.some((o) => o.ownerType === "clan" && o.ownerId === String(entry.clan.id) && o.itemId === "emblem-phoenix")) {
              await db.insert(schema.ownedItems).values({
                ownerType: "clan",
                ownerId: String(entry.clan.id),
                itemId: "emblem-phoenix",
                equipped: 0,
              });
            }
          }
          await db.insert(schema.seasonWinners).values({
            seasonKey: args.seasonKey,
            board: board.name,
            clanId: entry.clan.id,
            clanName: entry.clan.name,
            rank,
            seasonPoints: entry.s.effectiveSeasonPoints,
            creditsAwarded: credits,
            emblemAwarded,
          });
          paidClans.add(entry.clan.id);
          awardedClans = paidClans.size;
          totalCredits += credits;
        }
      }
      ctx.invalidateQueries();
      return { awardedClans, totalCredits };
    },
  }),

  getSeasonChallenges: defineAction({
    description: "Returns one season's Challenges board for a player: their XP and ViceSunshine level (XP is earned automatically from in-app activity only — attend an event +15, Feed post +5, a post reaching 10 likes +10, recruit +15; Level 2 at 200 XP, Level 3 at 500, Level 4 at 1,000, Level 5 at 2,000, then widening steps), the XP rates and level ladder, and the season's web-based-only challenges with automatic progress counted from the player's own ViceSunshine records. Targets rise every season. Completing a challenge unlocks that season's auto-generated calling card automatically — the card set is generated fresh every season at a higher design tier than the last. Past seasons stay viewable; their unlocked cards stay owned.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      seasonNumber: z.number().int().min(0).max(999).default(0),
    }),
    response: z.object({
      hasProfile: z.boolean(),
      seasonNumber: z.number(),
      currentSeasonNumber: z.number(),
      seasonKey: z.string(),
      seasonLabel: z.string(),
      seasonEndsAt: z.string(),
      isCurrent: z.boolean(),
      theme: z.string(),
      tier: z.number(),
      tierPerks: z.array(z.string()),
      xp: z.number(),
      level: z.number(),
      levelStart: z.number(),
      nextLevelAt: z.number(),
      xpRates: z.array(z.object({ action: z.string(), xp: z.string() })),
      levelSteps: z.array(z.object({ level: z.number(), xp: z.number() })),
      challenges: z.array(
        z.object({
          itemId: z.string(),
          metric: z.string(),
          title: z.string(),
          challenge: z.string(),
          target: z.number(),
          current: z.number(),
          unlocked: z.boolean(),
          equipped: z.boolean(),
          cardValue: z.string(),
          cardName: z.string(),
          scene: z.string(),
          animated: z.boolean(),
          artUrl: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const currentKey = seasonKeyOf(new Date());
      const currentNum = seasonNumberOfKey(currentKey);
      const n = args.seasonNumber > 0 ? Math.min(args.seasonNumber, currentNum) : currentNum;
      const key = seasonKeyForNumber(n);
      const profRows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const hasProfile = !!profRows[0];
      // Unlocking is automatic: completed challenges grant their
      // calling card the moment the board is read.
      if (hasProfile) await grantSeasonUnlocks(ctx, args.playerKey, key);
      const progress = await seasonChallengeProgress(ctx, args.playerKey, key);
      const owned = await db.select().from(schema.ownedItems);
      const equippedIds = new Set(
        owned.filter((o) => o.ownerType === "personal" && o.ownerId === args.playerKey && o.equipped === 1).map((o) => o.itemId),
      );
      const artUrls = await seasonCardArtUrls(ctx, n);
      const pointEvents = await db.select().from(schema.rankPointEvents);
      const xp = personalPointsOf(pointEvents, args.playerKey);
      const lvl = playerLevelFromPoints(xp);
      return {
        hasProfile,
        seasonNumber: n,
        currentSeasonNumber: currentNum,
        seasonKey: key,
        seasonLabel: seasonLabelOf(key),
        seasonEndsAt: seasonEndsAtOf(key),
        isCurrent: n === currentNum,
        theme: seasonThemeOf(n),
        tier: n,
        tierPerks: seasonTierPerks(n),
        xp,
        level: lvl.level,
        levelStart: lvl.levelStart,
        nextLevelAt: lvl.nextAt,
        xpRates: [
          { action: "Attend a community event (RSVP Going)", xp: `+${POINT_RATES.eventAttend} XP` },
          { action: "Post in the Community Feed", xp: `+${POINT_RATES.feedPost} XP` },
          { action: "Your Feed post reaches 10 likes", xp: `+${POINT_RATES.feed} XP` },
          { action: "Recruit — a member joins (joining a crew counts)", xp: `+${POINT_RATES.recruit} XP` },
          { action: "Win a community event (1st / 2nd / 3rd)", xp: "+50 / +30 / +20 XP" },
          { action: "Moderator-verified Easter egg", xp: `+${POINT_RATES.egg} XP` },
          { action: "Moderator-confirmed bug report", xp: `+${POINT_RATES.bug} XP` },
          { action: "Post in your crew feed", xp: `+${POINT_RATES.clanPost} XP` },
        ],
        levelSteps: Array.from({ length: 12 }, (_, i) => ({ level: i + 1, xp: xpThresholdForLevel(i + 1) })),
        challenges: seasonChallengesOf(n).map((def) => {
          const itemId = seasonCardItemId(n, def.metric);
          const p = progress.get(itemId) ?? { current: 0, target: seasonTargetOf(def, n), unlocked: false };
          const value = seasonCardValue(n, def.metric);
          return {
            itemId,
            metric: def.metric,
            title: def.title,
            challenge: def.challenge,
            target: p.target,
            current: p.current,
            unlocked: p.unlocked,
            equipped: equippedIds.has(itemId),
            cardValue: value,
            cardName: seasonCardItem(n, def).name,
            scene: def.scene,
            animated: n >= 2,
            artUrl: artUrls.get(value) ?? "",
          };
        }),
      };
    },
  }),

  refreshSeasonCards: defineAction({
    description: "Auto-generates the current season's calling card artwork: paints any missing cards in this season's auto-generated set (original ViceSunshine art, design tier rising every season so each season's set is better than the last) and stores them as owned blobs. Idempotent — a generated card is never repainted; a new season generates a brand-new set. Runs on the artwork schedule and can be called any time.",
    request: z.object({}),
    response: z.object({ generated: z.number(), remaining: z.number(), seasonNumber: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const n = seasonNumberOfKey(seasonKeyOf(new Date()));
      const rows = await db.select().from(schema.meta);
      const have = new Set(
        rows.filter((r) => r.key.startsWith("season-card-art:") && r.value).map((r) => r.key.slice("season-card-art:".length)),
      );
      let generated = 0;
      for (const def of seasonChallengesOf(n)) {
        if (generated >= 2) break;
        const value = seasonCardValue(n, def.metric);
        if (have.has(value)) continue;
        if (await generateSeasonCardArtFor(ctx, n, def)) generated += 1;
      }
      const remaining = seasonChallengesOf(n).filter((def) => !have.has(seasonCardValue(n, def.metric))).length - generated;
      await setMeta(ctx, "last_season_cards_refresh_at", new Date().toISOString());
      return { generated, remaining: Math.max(0, remaining), seasonNumber: n };
    },
  }),

  getCustomise: defineAction({
    description: "Returns the customisation catalogue with ownership and equipped state for the player and (optionally) their crew. Every section (avatars, avatar effects, badges, calling cards / banners, themes, crew emblems, crew colours, crew calling cards / banners) holds exactly 5 free items and 3 Premium items — no more. The calling card IS the profile / crew banner — there are no banner colours and no separate banner styles. Three extra personal calling cards are Challenge cards (Dark-Ops style): earned by completing in-app challenges, never for sale, reported here with progress and locked state. There are no name colours — every name is shown in white only. Everyday customisation is FREE — there is no Shop. The 3 Premium items in each section are part of the Premium membership, never sold separately, and free members cannot use them.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      clanId: z.number().int().min(0).default(0),
    }),
    response: z.object({
      items: z.array(cosmeticItemView),
      hasProfile: z.boolean(),
      clanName: z.string(),
      canCustomiseClan: z.boolean(),
      premiumActive: z.boolean(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profRows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const prof = profRows[0];
      const premiumActive = await premiumActiveFor(ctx, args.playerKey);
      const owned = await db.select().from(schema.ownedItems);
      const mineOwned = owned.filter((o) => o.ownerType === "personal" && o.ownerId === args.playerKey);
      let clanName = "";
      let canCustomiseClan = false;
      let clanOwned: typeof owned = [];
      if (args.clanId > 0) {
        const clanRows = await db.select().from(schema.clans).where(eq(schema.clans.id, args.clanId));
        const clan = clanRows[0];
        if (clan) {
          clanName = clan.name;
          clanOwned = owned.filter((o) => o.ownerType === "clan" && o.ownerId === String(args.clanId));
          const me = await myMembership(ctx, args.clanId, args.playerKey);
          canCustomiseClan = !!me && (me.role === "Leader" || me.role === "Co-Leader");
        }
      }
      const artUrls = await avatarArtUrls(ctx);
      const progress = prof ? await challengeProgress(ctx, args.playerKey) : new Map<string, { current: number; unlocked: boolean }>();
      // Season challenge cards: the current season's auto-generated
      // set (progress + locked state), plus any past-season cards the
      // player already unlocked (they stay equippable forever).
      const curSeasonKey = seasonKeyOf(new Date());
      const curSeasonNum = seasonNumberOfKey(curSeasonKey);
      if (prof) await grantSeasonUnlocks(ctx, args.playerKey, curSeasonKey);
      const seasonProgress = prof
        ? await seasonChallengeProgress(ctx, args.playerKey, curSeasonKey)
        : new Map<string, { current: number; target: number; unlocked: boolean }>();
      const seasonItems = seasonChallengesOf(curSeasonNum).map((def) => {
        const item = seasonCardItem(curSeasonNum, def);
        const p = seasonProgress.get(item.id) ?? { current: 0, target: seasonTargetOf(def, curSeasonNum), unlocked: false };
        return {
          id: item.id,
          name: item.name,
          description: item.description,
          scope: item.scope,
          kind: item.kind,
          value: item.value,
          ownedByMe: p.unlocked,
          equippedByMe: mineOwned.some((o) => o.itemId === item.id && o.equipped === 1),
          ownedByClan: false,
          equippedByClan: false,
          premiumOnly: false,
          imageUrl: "",
          challenge: `Season ${curSeasonNum}: ${def.challenge}`,
          progress: `${Math.min(p.current, p.target)} / ${p.target}`,
          locked: !p.unlocked,
        };
      });
      const pastSeasonItems = mineOwned
        .map((o) => seasonCardInfo(o.itemId))
        .filter((info): info is NonNullable<typeof info> => !!info && info.n !== curSeasonNum)
        .map((info) => ({
          id: info.item.id,
          name: info.item.name,
          description: info.item.description,
          scope: info.item.scope,
          kind: info.item.kind,
          value: info.item.value,
          ownedByMe: true,
          equippedByMe: mineOwned.some((o) => o.itemId === info.item.id && o.equipped === 1),
          ownedByClan: false,
          equippedByClan: false,
          premiumOnly: false,
          imageUrl: "",
          challenge: `Season ${info.n}: ${info.def.challenge}`,
          progress: "Unlocked",
          locked: false,
        }));
      return {
        items: [
          ...COSMETIC_ITEMS.map((i) => ({
            id: i.id,
            name: i.name,
            description: i.description,
            scope: i.scope,
            kind: i.kind,
            value: i.value,
            ownedByMe: mineOwned.some((o) => o.itemId === i.id),
            equippedByMe: mineOwned.some((o) => o.itemId === i.id && o.equipped === 1),
            ownedByClan: clanOwned.some((o) => o.itemId === i.id),
            equippedByClan: clanOwned.some((o) => o.itemId === i.id && o.equipped === 1),
            premiumOnly: i.premiumOnly === true,
            imageUrl: i.kind === "avatar" ? (artUrls.get(i.value) ?? "") : "",
            challenge: "",
            progress: "",
            locked: false,
          })),
          ...CHALLENGE_CARD_ITEMS.map((i) => {
            const p = progress.get(i.id) ?? { current: 0, unlocked: false };
            return {
              id: i.id,
              name: i.name,
              description: i.description,
              scope: i.scope,
              kind: i.kind,
              value: i.value,
              ownedByMe: p.unlocked,
              equippedByMe: mineOwned.some((o) => o.itemId === i.id && o.equipped === 1),
              ownedByClan: false,
              equippedByClan: false,
              premiumOnly: false,
              imageUrl: "",
              challenge: i.challenge,
              progress: `${Math.min(p.current, i.target)} / ${i.target}`,
              locked: !p.unlocked,
            };
          }),
          ...seasonItems,
          ...pastSeasonItems,
        ],
        hasProfile: !!prof,
        clanName,
        canCustomiseClan,
        premiumActive,
      };
    },
  }),

  equipCosmetic: defineAction({
    description: "Equips a customisation instantly: free catalogue items are granted on the spot (no credits, no payment, no Shop). Personal items (avatar, avatar effect, badge, calling card / banner, theme) update the profile; crew items (emblem, colour, calling card / banner) update the crew card and crew home. Challenge calling cards must be unlocked first (the challenge is counted automatically from in-app activity) — crew items need the Leader or a Co-Leader. Premium-only items (the 3 Premium picks in each Customise section) additionally need an active Premium membership — they are part of Premium, never sold separately, and free members cannot equip them. Crew Awards still must be earned first; they are granted by milestones, never equipped before they are earned.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      itemId: z.string().min(1).max(60),
      clanId: z.number().int().min(0).default(0),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      // Equipping works for any catalogue customisation (free, granted
      // on the spot) AND for Clan Awards the clan has earned (itemDef
      // covers both; awards are never auto-granted).
      const item = itemDef(args.itemId);
      if (!item) throw new Error("That customisation does not exist.");
      const owned = await db.select().from(schema.ownedItems);
      if (item.scope === "clan") {
        if (args.clanId <= 0) throw new Error("Pick which crew this is for first.");
        const me = await myMembership(ctx, args.clanId, args.playerKey);
        if (!me || (me.role !== "Leader" && me.role !== "Co-Leader")) {
          throw new Error("Only the crew Leader or a Co-Leader can change the crew's look.");
        }
        if (item.premiumOnly) {
          const clanOwns = owned.some((o) => o.ownerType === "clan" && o.ownerId === String(args.clanId) && o.itemId === item.id);
          if (!clanOwns && !(await premiumActiveFor(ctx, args.playerKey))) {
            throw new Error("That crew customisation is a Premium exclusive — the Leader or Co-Leader equipping it needs an active Premium membership. It is never sold separately.");
          }
        }
        let row = owned.find((o) => o.ownerType === "clan" && o.ownerId === String(args.clanId) && o.itemId === item.id);
        if (!row) {
          if (awardItem(args.itemId)) {
            throw new Error("Your crew has not earned this Crew Award yet — Crew Awards are earned together at milestones and are never for sale.");
          }
          await db.insert(schema.ownedItems).values({ ownerType: "clan", ownerId: String(args.clanId), itemId: item.id, equipped: 0 });
          const fresh = await db.select().from(schema.ownedItems);
          row = fresh.find((o) => o.ownerType === "clan" && o.ownerId === String(args.clanId) && o.itemId === item.id);
          if (!row) throw new Error("That customisation could not be applied — try again.");
        }
        for (const o of owned.filter((x) => x.ownerType === "clan" && x.ownerId === String(args.clanId))) {
          const def = itemDef(o.itemId);
          if (def && def.kind === item.kind && o.equipped !== 0) {
            await db.update(schema.ownedItems).set({ equipped: 0 }).where(eq(schema.ownedItems.id, o.id));
          }
        }
        await db.update(schema.ownedItems).set({ equipped: 1 }).where(eq(schema.ownedItems.id, row.id));
        if (item.kind === "emblem") {
          await db.update(schema.clans).set({ emblem: item.value }).where(eq(schema.clans.id, args.clanId));
        } else if (item.kind === "color") {
          await db.update(schema.clans).set({ color: item.value }).where(eq(schema.clans.id, args.clanId));
        } else if (item.kind === "banner") {
          await db.update(schema.clans).set({ bannerStyle: item.value }).where(eq(schema.clans.id, args.clanId));
        } else if (item.kind === "callingCard") {
          await db.update(schema.clans).set({ callingCard: item.value }).where(eq(schema.clans.id, args.clanId));
        }
        await logActivity(ctx, args.clanId, me.gamertag, "equipped a free customisation:", item.name, "");
      } else {
        const profRows = await db
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.playerKey, args.playerKey));
        const prof = profRows[0];
        if (!prof) throw new Error("Create your profile first — then customising it is free.");
        const challengeDef = challengeCardOf(item.id);
        if (challengeDef) {
          const p = (await challengeProgress(ctx, args.playerKey)).get(item.id);
          if (!p || !p.unlocked) {
            throw new Error(`That calling card is locked — complete the challenge first: ${challengeDef.challenge} (${p ? Math.min(p.current, challengeDef.target) : 0}/${challengeDef.target}). Challenge cards are earned, never for sale.`);
          }
        }
        const seasonInfo = seasonCardInfo(item.id);
        if (seasonInfo) {
          const p = (await seasonChallengeProgress(ctx, args.playerKey, seasonKeyForNumber(seasonInfo.n))).get(item.id);
          if (!p || !p.unlocked) {
            throw new Error(`That calling card is locked — complete its Season ${seasonInfo.n} challenge first: ${seasonInfo.def.challenge} (${p ? Math.min(p.current, p.target) : 0}/${p?.target ?? seasonTargetOf(seasonInfo.def, seasonInfo.n)}). Season challenge cards unlock automatically when the challenge is done — earned, never for sale.`);
          }
        }
        if (item.premiumOnly) {
          // Premium exclusives need an active Premium membership —
          // they are part of Premium, never sold separately.
          if (!(await premiumActiveFor(ctx, args.playerKey))) {
            throw new Error("That is a Premium exclusive — it is included with an active Premium membership and is never sold separately. Free members cannot use Premium items.");
          }
        }
        let row = owned.find((o) => o.ownerType === "personal" && o.ownerId === args.playerKey && o.itemId === item.id);
        if (!row) {
          await db.insert(schema.ownedItems).values({ ownerType: "personal", ownerId: args.playerKey, itemId: item.id, equipped: 0 });
          const fresh = await db.select().from(schema.ownedItems);
          row = fresh.find((o) => o.ownerType === "personal" && o.ownerId === args.playerKey && o.itemId === item.id);
          if (!row) throw new Error("That customisation could not be applied — try again.");
        }
        for (const o of owned.filter((x) => x.ownerType === "personal" && x.ownerId === args.playerKey)) {
          const def = itemDef(o.itemId);
          if (def && def.kind === item.kind && o.equipped !== 0) {
            await db.update(schema.ownedItems).set({ equipped: 0 }).where(eq(schema.ownedItems.id, o.id));
          }
        }
        await db.update(schema.ownedItems).set({ equipped: 1 }).where(eq(schema.ownedItems.id, row.id));
        if (item.kind === "badge") {
          await db.update(schema.profiles).set({ badge: item.value }).where(eq(schema.profiles.id, prof.id));
        } else if (item.kind === "bannerColor") {
          await db.update(schema.profiles).set({ bannerColor: item.value }).where(eq(schema.profiles.id, prof.id));
        } else if (item.kind === "avatar") {
          await db.update(schema.profiles).set({ avatarId: item.value, customAvatarBlobKey: "" }).where(eq(schema.profiles.id, prof.id));
        } else if (item.kind === "effect") {
          await db.update(schema.profiles).set({ avatarEffect: item.value }).where(eq(schema.profiles.id, prof.id));
        } else if (item.kind === "callingCard") {
          // Choosing a calling card replaces any uploaded banner
          // media — the card becomes the banner again.
          await db.update(schema.profiles).set({ callingCard: item.value, bannerBlobKey: "", bannerMediaType: "" }).where(eq(schema.profiles.id, prof.id));
        } else if (item.kind === "theme") {
          await db.update(schema.profiles).set({ themeAccent: item.value }).where(eq(schema.profiles.id, prof.id));
        }
      }
      ctx.invalidateQueries();
      return ok();
    },
  }),

  unequipCosmetic: defineAction({
    description: "Removes an equipped customisation, reverting that slot to the default look. Free, instant, and nothing is lost — the item stays available to equip again any time from Customise. Crew items need the Leader or a Co-Leader.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      itemId: z.string().min(1).max(60),
      clanId: z.number().int().min(0).default(0),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      await requireProfile(ctx, args.playerKey);
      const item = itemDef(args.itemId);
      if (!item) throw new Error("That customisation does not exist.");
      const owned = await db.select().from(schema.ownedItems);
      if (item.scope === "clan") {
        if (args.clanId <= 0) throw new Error("Pick which crew this is for first.");
        const me = await myMembership(ctx, args.clanId, args.playerKey);
        if (!me || (me.role !== "Leader" && me.role !== "Co-Leader")) {
          throw new Error("Only the crew Leader or a Co-Leader can change the crew's look.");
        }
        const row = owned.find((o) => o.ownerType === "clan" && o.ownerId === String(args.clanId) && o.itemId === item.id);
        if (row && row.equipped === 1) {
          await db.update(schema.ownedItems).set({ equipped: 0 }).where(eq(schema.ownedItems.id, row.id));
          if (item.kind === "emblem") await db.update(schema.clans).set({ emblem: "shield" }).where(eq(schema.clans.id, args.clanId));
          else if (item.kind === "color") await db.update(schema.clans).set({ color: "#FF2E88" }).where(eq(schema.clans.id, args.clanId));
          else if (item.kind === "banner") await db.update(schema.clans).set({ bannerStyle: "" }).where(eq(schema.clans.id, args.clanId));
          else if (item.kind === "callingCard") await db.update(schema.clans).set({ callingCard: "" }).where(eq(schema.clans.id, args.clanId));
        }
      } else {
        const profRows = await db
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.playerKey, args.playerKey));
        const prof = profRows[0];
        if (!prof) throw new Error("Profile not found.");
        const row = owned.find((o) => o.ownerType === "personal" && o.ownerId === args.playerKey && o.itemId === item.id);
        if (row && row.equipped === 1) {
          await db.update(schema.ownedItems).set({ equipped: 0 }).where(eq(schema.ownedItems.id, row.id));
          if (item.kind === "badge") await db.update(schema.profiles).set({ badge: "" }).where(eq(schema.profiles.id, prof.id));
          else if (item.kind === "bannerColor") await db.update(schema.profiles).set({ bannerColor: "" }).where(eq(schema.profiles.id, prof.id));
          else if (item.kind === "avatar") await db.update(schema.profiles).set({ avatarId: "" }).where(eq(schema.profiles.id, prof.id));
          else if (item.kind === "effect") await db.update(schema.profiles).set({ avatarEffect: "" }).where(eq(schema.profiles.id, prof.id));
          else if (item.kind === "callingCard") await db.update(schema.profiles).set({ callingCard: "" }).where(eq(schema.profiles.id, prof.id));
          else if (item.kind === "theme") await db.update(schema.profiles).set({ themeAccent: "" }).where(eq(schema.profiles.id, prof.id));
        }
      }
      ctx.invalidateQueries();
      return ok();
    },
  }),

  contributeToClan: defineAction({
    description: "Moves Vice Credits from the player's personal wallet into a crew wallet (any member can contribute). Logged on both sides.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      clanId: z.number().int().positive(),
      amount: z.number().int().min(1).max(100000),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const me = await myMembership(ctx, args.clanId, args.playerKey);
      if (!me) throw new Error("You can only contribute to a crew you belong to.");
      const profRows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const prof = profRows[0];
      if (!prof) throw new Error("Create your profile first.");
      if (prof.credits < args.amount) {
        throw new Error(`You have ${prof.credits} Vice Credits — you cannot contribute ${args.amount}.`);
      }
      const clanRows = await db.select().from(schema.clans).where(eq(schema.clans.id, args.clanId));
      const clan = clanRows[0];
      if (!clan) throw new Error("Crew not found.");
      await db
        .update(schema.profiles)
        .set({ credits: prof.credits - args.amount })
        .where(eq(schema.profiles.id, prof.id));
      await db
        .update(schema.clans)
        .set({ walletCredits: clan.walletCredits + args.amount })
        .where(eq(schema.clans.id, args.clanId));
      await logCredit(ctx, "personal", args.playerKey, args.playerKey, -args.amount, `Contributed to crew wallet — ${clan.name}`);
      await logCredit(ctx, "clan", String(args.clanId), args.playerKey, args.amount, `Member contribution from ${me.gamertag}`);
      await logActivity(ctx, args.clanId, me.gamertag, `contributed ${args.amount} Vice Credits to the crew wallet`, "", "");
      ctx.invalidateQueries();
      return ok();
    },
  }),

  subscribePremium: defineAction({
    description: "Starts a Premium subscription (CA$4.99/month), optionally with one of the player's saved payment methods for one-tap checkout. Payments are NOT connected yet (Stripe test mode only), so this never takes payment and never activates Premium — it returns the honest not-connected state until the owner activates Stripe Live.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      paymentMethodId: z.number().int().min(0).default(0),
    }),
    response: z.object({ status: z.string(), message: z.string() }),
    async handler(_ctx, args) {
      const db = _ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      if (!rows[0]) throw new Error("Create your ViceSunshine profile first, then subscribe.");
      if (rows[0].premium === 1) throw new Error("You already have Premium.");
      let cardNote = "";
      if (args.paymentMethodId > 0) {
        const methods = await db
          .select()
          .from(schema.paymentMethods)
          .where(eq(schema.paymentMethods.playerKey, args.playerKey));
        const method = methods.find((m) => m.id === args.paymentMethodId);
        if (!method) throw new Error("That saved payment method was not found — pick another or add a new one in Settings > Wallet.");
        cardNote = ` Your saved ${method.brand} •••• ${method.last4} is on file, so when checkout opens Premium starts with one tap — no re-entering your card.`;
      }
      return {
        status: "payments_not_connected",
        message:
          `Payments are not connected yet — checkout coming soon. Premium is ${PREMIUM_PRICE_CAD}/month (CAD), billed through secure Stripe checkout (card, Apple Pay, Google Pay) once the owner activates it. No payment was taken and Premium was not activated — it only ever starts after a successful payment.${cardNote}`,
      };
    },
  }),

  cancelPremium: defineAction({
    description: "Cancels the player's Premium subscription: it stays active until the end of the current paid month (weekly credits keep landing until then, then stop), and nothing is ever granted retroactively after it lapses.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({ ok: z.literal(true), endsAt: z.string() }),
    async handler(ctx, args): Promise<{ ok: true; endsAt: string }> {
      const db = ctx.db<typeof schema>();
      const state = await applyPremiumWeeklyCredits(ctx, args.playerKey);
      if (!state.active) throw new Error("You do not have an active Premium subscription to cancel.");
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const prof = rows[0];
      if (!prof) throw new Error("Profile not found.");
      if (prof.premiumEndsAt) {
        return { ok: true, endsAt: prof.premiumEndsAt.toISOString().slice(0, 10) };
      }
      const since = prof.premiumSince ?? new Date();
      const end = premiumPeriodEnd(since, new Date());
      await db
        .update(schema.profiles)
        .set({ premiumEndsAt: end })
        .where(eq(schema.profiles.id, prof.id));
      return { ok: true, endsAt: end.toISOString().slice(0, 10) };
    },
  }),

  resumePremium: defineAction({
    description: "Undoes a Premium cancellation before the paid month ends, so the subscription keeps renewing as before.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      const prof = rows[0];
      if (!prof || prof.premium !== 1) throw new Error("You do not have an active Premium subscription.");
      await db
        .update(schema.profiles)
        .set({ premiumEndsAt: null })
        .where(eq(schema.profiles.id, prof.id));
      return { ok: true };
    },
  }),

  // ---- Saved payment methods (Settings > Wallet) ----
  // Stripe collects the card in its own secure form; ViceSunshine only
  // ever stores what Stripe reports back — brand, last 4, expiry.
  // These actions manage that saved reference so Premium and credit
  // packs can be bought with one tap instead of re-entering details.
  // No action here accepts (or could store) a full card number, a
  // CVC, or bank account details.

  listPaymentMethods: defineAction({
    description: "Lists the player's saved payment methods for Settings > Wallet: brand, last 4 digits and expiry only (never a full card number), which one is the default, and whether live payments are connected yet.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({
      paymentsConnected: z.boolean(),
      items: z.array(
        z.object({
          id: z.number(),
          brand: z.string(),
          last4: z.string(),
          expMonth: z.number(),
          expYear: z.number(),
          label: z.string(),
          isDefault: z.boolean(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.paymentMethods)
        .where(eq(schema.paymentMethods.playerKey, args.playerKey))
        .orderBy(desc(schema.paymentMethods.isDefault), asc(schema.paymentMethods.id));
      return {
        // Stripe is connected in test mode only — no live charge can
        // be taken until the owner activates the Live account.
        paymentsConnected: false,
        items: rows.map((r) => ({
          id: r.id,
          brand: r.brand,
          last4: r.last4,
          expMonth: r.expMonth,
          expYear: r.expYear,
          label: r.label,
          isDefault: r.isDefault === 1,
        })),
      };
    },
  }),

  addPaymentMethod: defineAction({
    description: "Saves a payment method reference for one-tap checkout: brand, last 4 digits and expiry as reported by Stripe's secure card form. The request schema only has room for the last 4 digits — a full card number cannot be sent or stored. The first saved method becomes the default.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      brand: z.enum(["Visa", "Mastercard", "Amex", "Discover", "Interac", "Other card"]),
      last4: z.string().regex(/^\d{4}$/, "Enter exactly the last 4 digits of the card."),
      expMonth: z.number().int().min(1).max(12),
      expYear: z.number().int().min(2026).max(2045),
      label: z.string().trim().max(40).default(""),
    }),
    response: z.object({ ok: z.literal(true), id: z.number() }),
    async handler(ctx, args): Promise<{ ok: true; id: number }> {
      const db = ctx.db<typeof schema>();
      const profs = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.playerKey, args.playerKey));
      if (!profs[0]) throw new Error("Create your profile first — then you can save a payment method.");
      const now = new Date();
      if (args.expYear < now.getFullYear() || (args.expYear === now.getFullYear() && args.expMonth < now.getMonth() + 1)) {
        throw new Error("That card's expiry date has already passed — check the month and year.");
      }
      const mine = await db
        .select()
        .from(schema.paymentMethods)
        .where(eq(schema.paymentMethods.playerKey, args.playerKey));
      if (mine.length >= 5) throw new Error("You can save up to 5 payment methods — remove one first.");
      if (mine.some((m) => m.brand === args.brand && m.last4 === args.last4)) {
        throw new Error(`That ${args.brand} card ending in ${args.last4} is already saved.`);
      }
      const res = await db
        .insert(schema.paymentMethods)
        .values({
          playerKey: args.playerKey,
          brand: args.brand,
          last4: args.last4,
          expMonth: args.expMonth,
          expYear: args.expYear,
          label: args.label,
          isDefault: mine.length === 0 ? 1 : 0,
        })
        .returning({ id: schema.paymentMethods.id });
      ctx.invalidateQueries();
      return { ok: true, id: res[0]?.id ?? 0 };
    },
  }),

  removePaymentMethod: defineAction({
    description: "Removes one of the player's saved payment methods. If it was the default, the oldest remaining saved method becomes the default.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      id: z.number().int().positive(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.paymentMethods)
        .where(eq(schema.paymentMethods.playerKey, args.playerKey));
      const row = rows.find((r) => r.id === args.id);
      if (!row) throw new Error("That saved payment method was not found.");
      await db.delete(schema.paymentMethods).where(eq(schema.paymentMethods.id, row.id));
      if (row.isDefault === 1) {
        const rest = rows.filter((r) => r.id !== row.id).sort((a, b) => a.id - b.id);
        const next = rest[0];
        if (next) {
          await db
            .update(schema.paymentMethods)
            .set({ isDefault: 1 })
            .where(eq(schema.paymentMethods.id, next.id));
        }
      }
      ctx.invalidateQueries();
      return ok();
    },
  }),

  setDefaultPaymentMethod: defineAction({
    description: "Makes one of the player's saved payment methods the default used by the one-tap Premium button.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      id: z.number().int().positive(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.paymentMethods)
        .where(eq(schema.paymentMethods.playerKey, args.playerKey));
      const row = rows.find((r) => r.id === args.id);
      if (!row) throw new Error("That saved payment method was not found.");
      for (const r of rows) {
        if ((r.id === row.id) !== (r.isDefault === 1)) {
          await db
            .update(schema.paymentMethods)
            .set({ isDefault: r.id === row.id ? 1 : 0 })
            .where(eq(schema.paymentMethods.id, r.id));
        }
      }
      ctx.invalidateQueries();
      return ok();
    },
  }),

  // ---- Discord server invite ----
  // One community invite link, set by the admin in Settings and shown
  // on the single Discord card on the Create Account page. Stored in
  // meta; empty means "not set yet" and the card shows the
  // placeholder. The live link (https://discord.gg/NDH9XxyVkW,
  // provided by Ben Nov 19, 2026) was seeded by migration 0037,
  // filling the value only while it was still empty.
  getDiscordInvite: defineAction({
    description: "Returns the ViceSunshine Discord server invite link (empty when the admin has not set it yet) and, when a playerKey is given, whether that player has already joined the server — joined players never see the Discord card again.",
    request: z.object({ playerKey: z.string().max(80).default("") }),
    response: z.object({ url: z.string(), hasLink: z.boolean(), joined: z.boolean() }),
    async handler(ctx, args): Promise<{ url: string; hasLink: boolean; joined: boolean }> {
      const url = await getMeta(ctx, "discord_invite_url");
      let joined = false;
      if (args.playerKey) {
        const db = ctx.db<typeof schema>();
        const rows = await db
          .select()
          .from(schema.discordJoins)
          .where(eq(schema.discordJoins.playerKey, args.playerKey));
        joined = rows.length > 0;
      }
      return { url, hasLink: url.length > 0, joined };
    },
  }),

  markDiscordJoined: defineAction({
    description: "Records that this player has joined the ViceSunshine Discord server (their own confirmation, after tapping Join or via the card's 'I've already joined' control). The Discord card on the Create Account page never shows for them again. Idempotent.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({ ok: z.literal(true), joined: z.boolean() }),
    async handler(ctx, args): Promise<{ ok: true; joined: boolean }> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.discordJoins)
        .where(eq(schema.discordJoins.playerKey, args.playerKey));
      if (rows.length === 0) {
        await db.insert(schema.discordJoins).values({ playerKey: args.playerKey });
      }
      ctx.invalidateQueries();
      return { ok: true, joined: true };
    },
  }),

  setDiscordInvite: defineAction({
    description: "Admin: sets or clears (empty string) the ViceSunshine Discord server invite link shown across the app.",
    request: z.object({ url: z.string().trim().max(300).default("") }),
    response: z.object({ ok: z.literal(true), url: z.string() }),
    async handler(ctx, args): Promise<{ ok: true; url: string }> {
      const url = args.url.trim();
      if (url && !/^https:\/\/(discord\.gg\/|discord\.com\/invite\/|www\.discord\.com\/invite\/)[A-Za-z0-9-]+$/i.test(url)) {
        throw new Error("That doesn't look like a Discord invite link — paste a full https://discord.gg/... or https://discord.com/invite/... link, or leave it empty to clear it.");
      }
      await setMeta(ctx, "discord_invite_url", url);
      ctx.invalidateQueries();
      return { ok: true, url };
    },
  }),

  // ---- Clan channel management ----
  // Leader / Co-Leader structure their clan's text channels;
  // Elders can too, only when the Leader switched that on for the clan.

  createClanChannel: defineAction({
    description: "Creates a text channel in a crew (Leader / Co-Leader, or Elder when the Leader allows it). Channels can be Public or Private (roles / members allow-list).",
    request: z.object({
      clanId: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
      kind: z.enum(["text"]),
      name: z.string().trim().min(1).max(40),
      visibility: z.enum(["public", "private"]).default("public"),
      memberLimit: z.number().int().min(0).max(99).default(0),
      allowedRoles: z.array(z.enum(["Leader", "Co-Leader", "Elder", "Member", "Recruit"])).max(5).default([]),
      allowedKeys: z.array(z.string().min(1).max(80)).max(50).default([]),
    }),
    response: z.object({ id: z.number(), key: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const me = await myMembership(ctx, args.clanId, args.playerKey);
      if (!me) throw new Error("Join this crew before managing its channels.");
      const clanRows = await db.select().from(schema.clans).where(eq(schema.clans.id, args.clanId));
      const clan = clanRows[0];
      if (!clan) throw new Error("Crew not found.");
      if (!canManageChannels(me.role, clan)) {
        throw new Error(
          me.role === "Elder"
            ? "The Leader hasn't allowed Elders to manage channels in this crew."
            : "Only the Leader and Co-Leaders can manage channels (Elders too, if the Leader allows it).",
        );
      }
      const existing = await clanChannelsOf(ctx, args.clanId);
      if (existing.length >= 24) throw new Error("This crew already has 24 channels — delete one before adding another.");
      const base =
        args.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "channel";
      let key = base;
      let n = 2;
      while (existing.some((c) => c.key === key)) {
        key = `${base}-${n}`;
        n++;
      }
      const sortOrder = Math.max(0, ...existing.filter((c) => c.kind === args.kind).map((c) => c.sortOrder)) + 1;
      const res = await db
        .insert(schema.clanChannels)
        .values({
          clanId: args.clanId,
          kind: args.kind,
          key,
          name: args.name,
          visibility: args.visibility,
          allowedRoles: args.allowedRoles.join(","),
          allowedKeys: args.allowedKeys.join(","),
          memberLimit: 0,
          sortOrder,
        })
        .returning({ id: schema.clanChannels.id });
      await logActivity(ctx, args.clanId, me.gamertag, `created ${args.kind} channel`, args.name, "");
      ctx.invalidateQueries();
      return { id: res[0]?.id ?? 0, key };
    },
  }),

  updateClanChannel: defineAction({
    description: "Renames a crew channel and / or changes its Public / Private setting and its private allow-list (roles and members).",
    request: z.object({
      clanId: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
      channelId: z.number().int().positive(),
      name: z.string().trim().min(1).max(40).default(""),
      visibility: z.enum(["public", "private"]).default("public"),
      memberLimit: z.number().int().min(0).max(99).default(0),
      allowedRoles: z.array(z.enum(["Leader", "Co-Leader", "Elder", "Member", "Recruit"])).max(5).default([]),
      allowedKeys: z.array(z.string().min(1).max(80)).max(50).default([]),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const me = await myMembership(ctx, args.clanId, args.playerKey);
      if (!me) throw new Error("Join this crew before managing its channels.");
      const clanRows = await db.select().from(schema.clans).where(eq(schema.clans.id, args.clanId));
      const clan = clanRows[0];
      if (!clan) throw new Error("Crew not found.");
      if (!canManageChannels(me.role, clan)) {
        throw new Error("Only the Leader and Co-Leaders can manage channels (Elders too, if the Leader allows it).");
      }
      const rows = await db
        .select()
        .from(schema.clanChannels)
        .where(and(eq(schema.clanChannels.id, args.channelId), eq(schema.clanChannels.clanId, args.clanId)));
      const ch = rows[0];
      if (!ch) throw new Error("That channel no longer exists.");
      await db
        .update(schema.clanChannels)
        .set({
          name: args.name || ch.name,
          visibility: args.visibility,
          allowedRoles: args.allowedRoles.join(","),
          allowedKeys: args.allowedKeys.join(","),
          memberLimit: 0,
        })
        .where(eq(schema.clanChannels.id, ch.id));
      await logActivity(ctx, args.clanId, me.gamertag, "updated channel", args.name || ch.name, "");
      ctx.invalidateQueries();
      return ok();
    },
  }),

  deleteClanChannel: defineAction({
    description: "Deletes a crew text channel and its posts; a crew always keeps at least one text channel.",
    request: z.object({
      clanId: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
      channelId: z.number().int().positive(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const me = await myMembership(ctx, args.clanId, args.playerKey);
      if (!me) throw new Error("Join this crew before managing its channels.");
      const clanRows = await db.select().from(schema.clans).where(eq(schema.clans.id, args.clanId));
      const clan = clanRows[0];
      if (!clan) throw new Error("Crew not found.");
      if (!canManageChannels(me.role, clan)) {
        throw new Error("Only the Leader and Co-Leaders can manage channels (Elders too, if the Leader allows it).");
      }
      const all = await clanChannelsOf(ctx, args.clanId);
      const ch = all.find((c) => c.id === args.channelId);
      if (!ch) throw new Error("That channel no longer exists.");
      if (all.filter((c) => c.kind === ch.kind).length <= 1) {
        throw new Error(`A crew always keeps at least one ${ch.kind} channel — create the replacement first.`);
      }
      await db.delete(schema.clanChannels).where(eq(schema.clanChannels.id, ch.id));
      await db
        .delete(schema.clanPosts)
        .where(and(eq(schema.clanPosts.clanId, args.clanId), eq(schema.clanPosts.channel, ch.key)));
      await logActivity(ctx, args.clanId, me.gamertag, `deleted ${ch.kind} channel`, ch.name, "");
      ctx.invalidateQueries();
      return ok();
    },
  }),

  reorderClanChannels: defineAction({
    description: "Reorders a crew's channels of one kind: the channel ids are given in their new display order.",
    request: z.object({
      clanId: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
      kind: z.enum(["text"]),
      channelIds: z.array(z.number().int().positive()).min(1).max(24),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const me = await myMembership(ctx, args.clanId, args.playerKey);
      if (!me) throw new Error("Join this crew before managing its channels.");
      const clanRows = await db.select().from(schema.clans).where(eq(schema.clans.id, args.clanId));
      const clan = clanRows[0];
      if (!clan) throw new Error("Crew not found.");
      if (!canManageChannels(me.role, clan)) {
        throw new Error("Only the Leader and Co-Leaders can manage channels (Elders too, if the Leader allows it).");
      }
      const all = await clanChannelsOf(ctx, args.clanId);
      const base = 0;
      for (let i = 0; i < args.channelIds.length; i++) {
        const id = args.channelIds[i];
        if (id === undefined) continue;
        const ch = all.find((c) => c.id === id && c.kind === args.kind);
        if (!ch) continue;
        await db
          .update(schema.clanChannels)
          .set({ sortOrder: base + i })
          .where(eq(schema.clanChannels.id, ch.id));
      }
      ctx.invalidateQueries();
      return ok();
    },
  }),

  setClanChannelSettings: defineAction({
    description: "Leader only: lets Elders manage this crew's channels too, or takes that back.",
    request: z.object({
      clanId: z.number().int().positive(),
      playerKey: z.string().min(1).max(80),
      eldersCanManage: z.boolean(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      const me = await myMembership(ctx, args.clanId, args.playerKey);
      if (!me || me.role !== "Leader") throw new Error("Only the crew Leader can change who manages channels.");
      await db
        .update(schema.clans)
        .set({ eldersManageChannels: args.eldersCanManage ? 1 : 0 })
        .where(eq(schema.clans.id, args.clanId));
      await logActivity(
        ctx,
        args.clanId,
        me.gamertag,
        args.eldersCanManage ? "allowed Elders to manage channels" : "removed Elders' channel management",
        "",
        "",
      );
      ctx.invalidateQueries();
      return ok();
    },
  }),

  getAutomationStatus: defineAction({
    description: "Returns ViceSunshine's self-monitoring status: when each automatic system last ran (news & patch refresh, trending Feed media, TikTok clips, Database sync, bug tracker refresh, moderation sweep), how many items each holds, and how many posts are currently flagged. Powers the status shown to the owner (and the 'automatically updated' line on News).",
    request: z.object({}),
    response: z.object({
      newsLastAt: z.string(),
      feedMediaLastAt: z.string(),
      clipsLastAt: z.string(),
      dbSyncLastAt: z.string(),
      sweepLastAt: z.string(),
      bugsLastAt: z.string(),
      newsCount: z.number(),
      dbCount: z.number(),
      feedPostCount: z.number(),
      bugCount: z.number(),
      autoBugCount: z.number(),
      flaggedCount: z.number(),
      openSupportCount: z.number(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const [newsRows, dbRows, feedRows, supportRows, bugRows] = await Promise.all([
        db.select().from(schema.news),
        db.select().from(schema.dbEntries),
        db.select().from(schema.feedPosts),
        db.select().from(schema.supportRequests),
        db.select().from(schema.bugs),
      ]);
      return {
        newsLastAt: await getMeta(ctx, "last_refreshed_at"),
        feedMediaLastAt: await getMeta(ctx, "last_feed_media_refresh_at"),
        clipsLastAt: await getMeta(ctx, "last_tiktok_clips_refresh_at"),
        dbSyncLastAt: await getMeta(ctx, "last_db_sync_at"),
        sweepLastAt: await getMeta(ctx, "last_automation_sweep_at"),
        bugsLastAt: await getMeta(ctx, "last_bugs_refresh_at"),
        newsCount: newsRows.length,
        dbCount: dbRows.length,
        feedPostCount: feedRows.length,
        bugCount: bugRows.length,
        autoBugCount: bugRows.filter((r) => r.auto === 1).length,
        flaggedCount: feedRows.filter((r) => r.flagged === 1).length,
        openSupportCount: supportRows.filter((r) => r.status === "Open").length,
      };
    },
  }),

  automationSweep: defineAction({
    description: "The self-monitoring sweep (runs automatically every hour): re-screens the most recent Feed posts, comments and crew chat messages against the automatic moderation rules — posts that fail are flagged and hidden, comments and crew messages that fail are removed — and re-screens public profile names and bios with the stricter name screen, counting any that fail for the owner dashboard's moderation queue (the sweep never renames or deletes a profile itself). Private DMs are never scanned. Automatic posts are team-curated and skipped.",
    request: z.object({}),
    response: z.object({ postsFlagged: z.number(), commentsRemoved: z.number(), clanPostsRemoved: z.number(), profilesFlagged: z.number(), sweptAt: z.string() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      let postsFlagged = 0;
      let commentsRemoved = 0;
      let clanPostsRemoved = 0;
      const posts = await db.select().from(schema.feedPosts).orderBy(desc(schema.feedPosts.id));
      for (const post of posts.slice(0, 300)) {
        if (post.auto === 1 || post.flagged === 1) continue;
        if (screenText(post.title) || screenText(post.body) || screenMediaUrl(post.mediaUrl)) {
          await db.update(schema.feedPosts).set({ flagged: 1 }).where(eq(schema.feedPosts.id, post.id));
          postsFlagged += 1;
        }
      }
      const comments = await db.select().from(schema.feedComments).orderBy(desc(schema.feedComments.id));
      for (const comment of comments.slice(0, 300)) {
        if (screenText(comment.body)) {
          await db.delete(schema.feedComments).where(eq(schema.feedComments.id, comment.id));
          commentsRemoved += 1;
        }
      }
      const clanPosts = await db.select().from(schema.clanPosts).orderBy(desc(schema.clanPosts.id));
      for (const post of clanPosts.slice(0, 300)) {
        if (screenText(post.body)) {
          await db.delete(schema.clanPosts).where(eq(schema.clanPosts.id, post.id));
          clanPostsRemoved += 1;
        }
      }
      // Profiles are public content: re-screen names and bios.
      // Counted only — the owner dashboard lists the failing
      // profiles by name for human review.
      let profilesFlagged = 0;
      const allProfiles = await db.select().from(schema.profiles).orderBy(desc(schema.profiles.id));
      for (const p of allProfiles.slice(0, 300)) {
        if (screenProfileName(p.gamertag) || screenProfileName(p.displayName) || screenText(p.bio, true)) {
          profilesFlagged += 1;
        }
      }
      const sweptAt = new Date().toISOString();
      await setMeta(ctx, "last_automation_sweep_at", sweptAt);
      if (postsFlagged + commentsRemoved + clanPostsRemoved + profilesFlagged > 0) ctx.invalidateQueries();
      return { postsFlagged, commentsRemoved, clanPostsRemoved, profilesFlagged, sweptAt };
    },
  }),

  getOwnerDashboard: defineAction({
    description: "Owner-only dashboard data for the ViceSunshine owner account (the first / creator account): player counts and newest players, Premium members and revenue state, content counts, the moderation queue (flagged Feed posts and bugs with report counts), recent reports, and open support requests. Throws for every non-owner account.",
    request: z.object({ playerKey: z.string().min(1).max(80) }),
    response: z.object({
      ownerGamertag: z.string(),
      totalUsers: z.number(),
      newUsers7d: z.number(),
      premiumMembers: z.number(),
      premiumPriceCad: z.number(),
      paymentsConnected: z.boolean(),
      revenueTakenCad: z.number(),
      clanCount: z.number(),
      feedPostCount: z.number(),
      eventCount: z.number(),
      flaggedPostCount: z.number(),
      openSupportCount: z.number(),
      newUsers: z.array(z.object({ gamertag: z.string(), platform: z.string(), premium: z.boolean(), joinedAt: z.string() })),
      flaggedPosts: z.array(z.object({ id: z.number(), author: z.string(), kind: z.string(), excerpt: z.string(), reports: z.number(), firstReason: z.string() })),
      flaggedBugs: z.array(z.object({ id: z.number(), title: z.string(), reports: z.number() })),
      supportRequests: z.array(z.object({ id: z.number(), gamertag: z.string(), topic: z.string(), details: z.string(), status: z.string(), createdAt: z.string() })),
      recentReports: z.array(z.object({ postId: z.number(), reason: z.string(), createdAt: z.string() })),
      reportedPlayers: z.array(z.object({ playerKey: z.string(), gamertag: z.string(), reports: z.number(), reasons: z.array(z.string()), latestDetails: z.string(), latestAt: z.string() })),
      flaggedProfiles: z.array(z.object({ gamertag: z.string(), displayName: z.string(), reason: z.string() })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const owner = await assertOwner(ctx, args.playerKey);
      const [profiles, clans, feedPosts, events, reports, bugs, support, playerReports] = await Promise.all([
        db.select().from(schema.profiles),
        db.select().from(schema.clans),
        db.select().from(schema.feedPosts),
        db.select().from(schema.events),
        db.select().from(schema.feedReports),
        db.select().from(schema.bugs),
        db.select().from(schema.supportRequests),
        db.select().from(schema.playerReports),
      ]);
      const bugReports = await db.select().from(schema.bugReports);
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const byNewest = [...profiles].sort((a, b) => b.id - a.id);
      const reportsByPost = new Map<number, typeof reports>();
      for (const r of reports) reportsByPost.set(r.postId, [...(reportsByPost.get(r.postId) ?? []), r]);
      const reportsByBug = new Map<number, number>();
      for (const r of bugReports) reportsByBug.set(r.bugId, (reportsByBug.get(r.bugId) ?? 0) + 1);
      return {
        ownerGamertag: owner.gamertag,
        totalUsers: profiles.length,
        newUsers7d: profiles.filter((pr) => pr.createdAt.getTime() >= weekAgo).length,
        premiumMembers: profiles.filter((pr) => pr.premium === 1).length,
        premiumPriceCad: 4.99,
        // Honest revenue state: Premium checkout is not connected
        // yet (Stripe is in test mode), so no sale has ever been
        // taken through ViceSunshine — the dashboard says so instead
        // of inventing a revenue figure.
        paymentsConnected: false,
        revenueTakenCad: 0,
        clanCount: clans.length,
        feedPostCount: feedPosts.length,
        eventCount: events.length,
        flaggedPostCount: feedPosts.filter((pr) => pr.flagged === 1).length,
        openSupportCount: support.filter((sr) => sr.status === "Open").length,
        newUsers: byNewest.slice(0, 12).map((pr) => ({
          gamertag: pr.gamertag,
          platform: pr.platform,
          premium: pr.premium === 1,
          joinedAt: pr.createdAt.toISOString(),
        })),
        flaggedPosts: feedPosts
          .filter((pr) => pr.flagged === 1)
          .sort((a, b) => b.id - a.id)
          .slice(0, 20)
          .map((pr) => ({
            id: pr.id,
            author: pr.author,
            kind: pr.kind,
            excerpt: (pr.title || pr.body).slice(0, 140),
            reports: (reportsByPost.get(pr.id) ?? []).length,
            firstReason: (reportsByPost.get(pr.id) ?? [])[0]?.reason ?? "",
          })),
        flaggedBugs: bugs
          .filter((b) => b.flagged === 1)
          .slice(0, 20)
          .map((b) => ({ id: b.id, title: b.title, reports: reportsByBug.get(b.id) ?? 0 })),
        reportedPlayers: (() => {
          const byPlayer = new Map<string, typeof playerReports>();
          for (const r of playerReports) byPlayer.set(r.reportedKey, [...(byPlayer.get(r.reportedKey) ?? []), r]);
          const profileByKey = new Map(profiles.map((pr) => [pr.playerKey, pr]));
          return [...byPlayer.entries()]
            .map(([key, rs]) => {
              const latest = [...rs].sort((a, b) => b.id - a.id)[0];
              return {
                playerKey: key,
                gamertag: profileByKey.get(key)?.gamertag ?? "Unknown player",
                reports: rs.length,
                reasons: [...new Set(rs.map((r) => r.reason))],
                latestDetails: latest?.details ?? "",
                latestAt: latest?.createdAt.toISOString() ?? "",
              };
            })
            .sort((a, b) => b.reports - a.reports)
            .slice(0, 20);
        })(),
        flaggedProfiles: profiles
          .map((pr) => ({ pr, reason: screenProfileName(pr.gamertag) ?? screenProfileName(pr.displayName) ?? screenText(pr.bio, true) }))
          .filter((x) => x.reason)
          .slice(0, 20)
          .map((x) => ({ gamertag: x.pr.gamertag, displayName: x.pr.displayName, reason: x.reason ?? "" })),
        supportRequests: [...support]
          .sort((a, b) => b.id - a.id)
          .slice(0, 20)
          .map((sr) => ({
            id: sr.id,
            gamertag: sr.gamertag,
            topic: sr.topic,
            details: sr.details.slice(0, 240),
            status: sr.status,
            createdAt: sr.createdAt.toISOString(),
          })),
        recentReports: [...reports]
          .sort((a, b) => b.id - a.id)
          .slice(0, 10)
          .map((r) => ({ postId: r.postId, reason: r.reason, createdAt: r.createdAt.toISOString() })),
      };
    },
  }),

  ownerRemoveFeedPost: defineAction({
    description: "Owner moderation: permanently removes a Feed post and its comments, likes, reports and repost records. Owner account only.",
    request: z.object({ playerKey: z.string().min(1).max(80), postId: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      await assertOwner(ctx, args.playerKey);
      await db.delete(schema.feedComments).where(eq(schema.feedComments.postId, args.postId));
      await db.delete(schema.feedReactions).where(eq(schema.feedReactions.postId, args.postId));
      await db.delete(schema.feedReports).where(eq(schema.feedReports.postId, args.postId));
      await db.delete(schema.feedReposts).where(eq(schema.feedReposts.postId, args.postId));
      await db.delete(schema.feedPosts).where(eq(schema.feedPosts.id, args.postId));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  ownerClearFeedFlag: defineAction({
    description: "Owner moderation: clears a Feed post's flag (and its reports) after review, so it shows in the Feed again. Owner account only.",
    request: z.object({ playerKey: z.string().min(1).max(80), postId: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      await assertOwner(ctx, args.playerKey);
      await db.update(schema.feedPosts).set({ flagged: 0 }).where(eq(schema.feedPosts.id, args.postId));
      await db.delete(schema.feedReports).where(eq(schema.feedReports.postId, args.postId));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  ownerRemoveBug: defineAction({
    description: "Owner moderation: removes a bug report from the tracker. Owner account only.",
    request: z.object({ playerKey: z.string().min(1).max(80), bugId: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      await assertOwner(ctx, args.playerKey);
      await db.delete(schema.bugReports).where(eq(schema.bugReports.bugId, args.bugId));
      await db.delete(schema.bugs).where(eq(schema.bugs.id, args.bugId));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  ownerSetSupportStatus: defineAction({
    description: "Owner support: marks a support request Open or Resolved. Owner account only.",
    request: z.object({
      playerKey: z.string().min(1).max(80),
      requestId: z.number().int().positive(),
      status: z.enum(["Open", "Resolved"]),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      await assertOwner(ctx, args.playerKey);
      await db.update(schema.supportRequests).set({ status: args.status }).where(eq(schema.supportRequests.id, args.requestId));
      ctx.invalidateQueries();
      return ok();
    },
  }),

  resetTestAccounts: defineAction({
    description: "ONE-TIME fresh start (owner's direction, Nov 20 2026; second cleanup Nov 20 2026 20:00 MST): deletes every real (non-bot) account created so far — all of them are the owner's own test sign-ups — together with everything tied to those accounts (profiles incl. password hashes and 2-step secrets, pending email codes for their addresses, posts, comments, likes, stories, follows, saves, wallet and points rows), so he can create a clean account. The seeded community members (player keys starting 'bot-') and their crews, posts and follows are NOT touched. Guarded by a meta flag: this v2 cleanup runs exactly once and every later call is a no-op.",
    request: z.object({}),
    response: z.object({ ok: z.literal(true), deletedAccounts: z.number(), alreadyDone: z.boolean() }),
    async handler(ctx): Promise<{ ok: true; deletedAccounts: number; alreadyDone: boolean }> {
      const db = ctx.db<typeof schema>();
      const FLAG = "test-accounts-reset-2026-11-20-v2";
      const flags = await db.select().from(schema.meta);
      if (flags.some((m) => m.key === FLAG)) return { ok: true, deletedAccounts: 0, alreadyDone: true };
      const allProfiles = await db.select().from(schema.profiles);
      const testProfiles = allProfiles.filter((p) => !p.playerKey.startsWith("bot-"));
      const keys = testProfiles.map((p) => p.playerKey);
      const emails = testProfiles.map((p) => p.email.trim().toLowerCase()).filter(Boolean);
      if (keys.length > 0) {
        const allPosts = await db.select().from(schema.feedPosts);
        const myPostIds = allPosts.filter((p) => keys.includes(p.authorKey)).map((p) => p.id);
        const allStories = await db.select().from(schema.stories);
        const myStoryIds = allStories.filter((s) => keys.includes(s.authorKey)).map((s) => s.id);
        const allHighlights = await db.select().from(schema.storyHighlights);
        const myHighlightIds = allHighlights.filter((h) => keys.includes(h.playerKey)).map((h) => h.id);
        const stmts: BatchItem<"sqlite">[] = [];
        const del = (t: never, w: never) => { stmts.push(db.delete(t).where(w) as never); };
        for (const key of keys) {
          del(schema.bugVotes as never, eq(schema.bugVotes.playerKey, key) as never);
          del(schema.bugReports as never, eq(schema.bugReports.reporterKey, key) as never);
          del(schema.eggs as never, eq(schema.eggs.submitterKey, key) as never);
          del(schema.blockedUsers as never, eq(schema.blockedUsers.playerKey, key) as never);
          del(schema.blockedUsers as never, eq(schema.blockedUsers.blockedKey, key) as never);
          del(schema.clanMembers as never, eq(schema.clanMembers.playerKey, key) as never);
          del(schema.clanApplications as never, eq(schema.clanApplications.playerKey, key) as never);
          del(schema.rsvps as never, eq(schema.rsvps.playerKey, key) as never);
          del(schema.eventKicked as never, eq(schema.eventKicked.playerKey, key) as never);
          del(schema.feedPosts as never, eq(schema.feedPosts.authorKey, key) as never);
          del(schema.feedReposts as never, eq(schema.feedReposts.playerKey, key) as never);
          del(schema.feedReactions as never, eq(schema.feedReactions.playerKey, key) as never);
          del(schema.feedComments as never, eq(schema.feedComments.authorKey, key) as never);
          del(schema.feedCommentReactions as never, eq(schema.feedCommentReactions.playerKey, key) as never);
          del(schema.feedViews as never, eq(schema.feedViews.playerKey, key) as never);
          del(schema.feedSaves as never, eq(schema.feedSaves.playerKey, key) as never);
          del(schema.accountSaves as never, eq(schema.accountSaves.playerKey, key) as never);
          del(schema.stories as never, eq(schema.stories.authorKey, key) as never);
          del(schema.storyViews as never, eq(schema.storyViews.playerKey, key) as never);
          del(schema.storyLikes as never, eq(schema.storyLikes.playerKey, key) as never);
          del(schema.storyReplies as never, eq(schema.storyReplies.playerKey, key) as never);
          del(schema.storyHiddenFrom as never, eq(schema.storyHiddenFrom.playerKey, key) as never);
          del(schema.storyHiddenFrom as never, eq(schema.storyHiddenFrom.hiddenKey, key) as never);
          del(schema.storyHighlights as never, eq(schema.storyHighlights.playerKey, key) as never);
          del(schema.feedReports as never, eq(schema.feedReports.reporterKey, key) as never);
          del(schema.playerReports as never, eq(schema.playerReports.reporterKey, key) as never);
          del(schema.playerReports as never, eq(schema.playerReports.reportedKey, key) as never);
          del(schema.feedHidden as never, eq(schema.feedHidden.playerKey, key) as never);
          del(schema.creditTransactions as never, eq(schema.creditTransactions.actorKey, key) as never);
          del(schema.rankPointEvents as never, eq(schema.rankPointEvents.playerKey, key) as never);
          del(schema.warActivity as never, eq(schema.warActivity.playerKey, key) as never);
          del(schema.activityReports as never, eq(schema.activityReports.reporterKey, key) as never);
          del(schema.ownedItems as never, and(eq(schema.ownedItems.ownerType, "personal"), eq(schema.ownedItems.ownerId, key)) as never);
          del(schema.dbRatings as never, eq(schema.dbRatings.playerKey, key) as never);
          del(schema.voiceParticipants as never, eq(schema.voiceParticipants.playerKey, key) as never);
          del(schema.voiceSignals as never, eq(schema.voiceSignals.fromKey, key) as never);
          del(schema.voiceSignals as never, eq(schema.voiceSignals.toKey, key) as never);
          del(schema.voiceReports as never, eq(schema.voiceReports.reporterKey, key) as never);
          del(schema.lfgMembers as never, eq(schema.lfgMembers.playerKey, key) as never);
          del(schema.lfgPosts as never, eq(schema.lfgPosts.authorKey, key) as never);
          del(schema.notifications as never, eq(schema.notifications.playerKey, key) as never);
          del(schema.partyCalls as never, eq(schema.partyCalls.hostKey, key) as never);
          del(schema.partyMembers as never, eq(schema.partyMembers.playerKey, key) as never);
          del(schema.paymentMethods as never, eq(schema.paymentMethods.playerKey, key) as never);
          del(schema.discordJoins as never, eq(schema.discordJoins.playerKey, key) as never);
          del(schema.profileFollows as never, eq(schema.profileFollows.followerKey, key) as never);
          del(schema.profileFollows as never, eq(schema.profileFollows.followingKey, key) as never);
          del(schema.followEvents as never, eq(schema.followEvents.followerKey, key) as never);
          del(schema.followEvents as never, eq(schema.followEvents.followingKey, key) as never);
          del(schema.directMessages as never, eq(schema.directMessages.senderKey, key) as never);
          del(schema.directMessages as never, eq(schema.directMessages.recipientKey, key) as never);
          del(schema.chatGroups as never, eq(schema.chatGroups.ownerKey, key) as never);
          del(schema.chatGroupMembers as never, eq(schema.chatGroupMembers.playerKey, key) as never);
          del(schema.dmPins as never, eq(schema.dmPins.playerKey, key) as never);
          del(schema.dmPins as never, eq(schema.dmPins.otherKey, key) as never);
          del(schema.supportRequests as never, eq(schema.supportRequests.playerKey, key) as never);
        }
        for (const pid of myPostIds) {
          del(schema.feedComments as never, eq(schema.feedComments.postId, pid) as never);
          del(schema.feedReactions as never, eq(schema.feedReactions.postId, pid) as never);
          del(schema.feedViews as never, eq(schema.feedViews.postId, pid) as never);
          del(schema.feedSaves as never, eq(schema.feedSaves.postId, pid) as never);
          del(schema.feedReposts as never, eq(schema.feedReposts.postId, pid) as never);
          del(schema.feedReports as never, eq(schema.feedReports.postId, pid) as never);
          del(schema.feedHidden as never, eq(schema.feedHidden.postId, pid) as never);
        }
        for (const sid of myStoryIds) {
          del(schema.storyViews as never, eq(schema.storyViews.storyId, sid) as never);
          del(schema.storyLikes as never, eq(schema.storyLikes.storyId, sid) as never);
          del(schema.storyReplies as never, eq(schema.storyReplies.storyId, sid) as never);
        }
        for (const hid of myHighlightIds) {
          del(schema.storyHighlightItems as never, eq(schema.storyHighlightItems.highlightId, hid) as never);
        }
        for (const email of emails) {
          del(schema.emailCodes as never, eq(schema.emailCodes.email, email) as never);
        }
        for (const key of keys) {
          del(schema.profiles as never, eq(schema.profiles.playerKey, key) as never);
        }
        stmts.push(db.insert(schema.meta).values({ key: FLAG, value: new Date().toISOString() }) as never);
        const [first, ...rest] = stmts;
        if (first) await db.batch([first, ...rest]);
      } else {
        await db.insert(schema.meta).values({ key: FLAG, value: new Date().toISOString() });
      }
      ctx.invalidateQueries();
      return { ok: true, deletedAccounts: keys.length, alreadyDone: false };
    },
  }),

  seedBots: defineAction({
    description: "One-time community seed (owner's direction, Nov 19 2026): creates 200 low-level community member accounts — every one with a different realistic name (mixed gaming names and real names), an avatar, a bio and an equipped calling card on many — 20 realistic crews made of them (joinable straight away), their current-season Rank Points (95% low level, 5% medium, so real players overtake them easily), their Feed life (posts, comments and likes), and mutual follows so each profile carries a follower count in the low hundreds. Deterministic and idempotent: if the seed accounts already exist it changes nothing, and it never touches real players' rows.",
    request: z.object({}),
    response: seedBotsResponse,
    async handler(ctx): Promise<z.infer<typeof seedBotsResponse>> {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.profiles);
      const already = existing.filter((p) => p.playerKey.startsWith("bot-")).length;
      // Fully seeded = profiles + Feed posts + follows all present.
      // Anything less and the phases below run with per-phase
      // existence guards, so a re-run converges instead of
      // duplicating (the follows phase alone is ~28k rows).
      const allFollowsSeed = await db.select().from(schema.profileFollows);
      const botFollowCountSeed = allFollowsSeed.filter((f) => f.followerKey.startsWith("bot-")).length;
      const allPostsSeed = await db.select().from(schema.feedPosts);
      const botPostsExistSeed = allPostsSeed.some((p) => p.authorKey.startsWith("bot-"));
      if (already >= 150 && botFollowCountSeed >= 20000 && botPostsExistSeed) {
        return { ok: true as const, alreadySeeded: true, profilesCreated: 0, crewsCreated: 0, postsCreated: 0, commentsCreated: 0, likesCreated: 0, followsCreated: 0 };
      }
      // Deterministic RNG so a re-run would rebuild the same cast.
      let rngState = 20261119;
      const rnd = () => {
        rngState |= 0; rngState = (rngState + 0x6d2b79f5) | 0;
        let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)] as T;
      const now = Date.now();
      // The seed's own accounts never block its deterministic names.
      const takenNames = new Set(existing.filter((p) => !p.playerKey.startsWith("bot-")).map((p) => p.gamertag.trim().toLowerCase()));
      const GAMING_STEMS = ["ViceCityVandal", "NeonDrifter", "PalmTreePapi", "LeonidaLurker", "MidnightCauseway", "SunsetStriker", "KeysRunner", "ViceVandal", "OceanDriveOllie", "NeonNights", "PalmReaperFan", "StreetHeat", "TurboFlamingo", "GatorBait", "ViceCityGhost", "LowriderLou", "NeonOutlaw", "BaysideBandit", "CrocodileCruiser", "ViceVeteran", "MoonlitMarauder", "SynthwaveSam", "HarborHustler", "NeonNomad", "PalmShade", "ViceCityViper", "TropicThunder", "BoardwalkBoss", "NeonNighthawk", "CausewayKing", "ViceVibes", "LagoonLegend", "StreetSerpent", "NeonTide", "PalmettoProwler", "ViceCityVixen", "DriftwoodDan", "NeonReef", "SunsetSheriff", "ViceUndertow", "MangroveMike", "NeonMirage", "BayfrontBandit", "ViceCityVoyager", "CanalCrawler", "NeonDuchess", "PalmCourtPete", "ViceVendetta", "StormSurge", "NeonLagoon", "BackwaterBob", "ViceCityVandal2", "TidePoolTess", "NeonFreeway", "HarborLights", "ViceVagabond", "SwampFox", "NeonBoardwalk", "CausewayGhost", "ViceCityWanderer", "PierPressure", "NeonEverglade", "SunsetDrifter"];
      const FIRST_NAMES = ["Marcus", "Elena", "Jayden", "Sofia", "Darius", "Priya", "Tommy", "Alicia", "Kenji", "Rosa", "Malik", "Tanya", "Diego", "Maya", "Andre", "Lucia", "Omar", "Freya", "Carlos", "Nina", "Jamal", "Petra", "Hugo", "Ines", "Rafael", "Mila", "Dante", "Yuki", "Felix", "Amara", "Victor", "Lena", "Silas", "Carmen", "Ezra", "Nadia", "Bruno", "Alba", "Kofi", "Renata", "Mateo", "Ivy", "Dario", "Selin"];
      const LAST_NAMES = ["Torres", "Kim", "Novak", "Reyes", "Haddad", "Ortiz", "Lindqvist", "Marsh", "Delgado", "Okafor", "Petrov", "Salinas", "Moreau", "Ibarra", "Kowalski", "Ferrer", "Nakamura", "Boateng", "Vargas", " Lindgren", "Costa", "Rinaldi", "Osman", "Ferraro", "Lindberg", "Acosta", "Brandt", "Serra", "Marino", "Kaur", "Duarte", "Almeida", "Rossi", "Ferro", "Soler", "Vidal", "Marek", "Iversen", "Roig", "Tarradell", "Bosc", "Pons", "Grau", "Vila"];
      const REGIONS = ["Vice City", "Leonida Keys", "Port Gellhorn", "Yorktown", "Ambrosia", "Mount Kalaga", "Florida", "Georgia", "Texas", "California", "New York", "Ontario", "Arizona", "Nevada", "Illinois", "Washington"];
      const PLAYSTYLES = ["Chill", "Grinder", "Explorer", "Racer", "Completionist", "Roleplay", "Story first", "Chaos"];
      const BIOS = ["Here for launch day. Leonida forever.", "Story mode first, everything else after.", "Car meets and chill drives.", "100% completion or nothing.", "Just vibing around Vice City.", "Crew player — always down for events.", "Exploring every corner of Leonida.", "Racing lines > everything.", "Here for the Easter eggs nobody has found yet.", "PS5 day one. Let's go.", "Taking screenshots more than playing, honestly.", "Missions, money, and midnight drives.", "Looking for a solid crew.", "Leonida Keys enjoyer.", "Saving up for my dream garage.", "If there's a ramp, I'm jumping it.", "Vice City born and raised (in my head).", "Ask me about my garage.", ""];
      const AVATARS = ["street", "crew", "driver", "surfer", "racer"];
      const FREE_CARDS = ["vice-nights", "street-heat", "palm-reaper", "keys-runner", "skull-strip"];
      const usedNames = new Set<string>();
      const gamertagFor = (i: number): string => {
        for (let attempt = 0; attempt < 40; attempt++) {
          let name: string;
          if (i % 5 < 3) {
            const stem = pick(GAMING_STEMS);
            const suffix = pick(["", "", "", "7", "99", "305", "x", "VI", "_", "OG", "24", "88"]);
            name = (stem + suffix).slice(0, 32);
          } else {
            const first = pick(FIRST_NAMES);
            const last = pick(LAST_NAMES).trim();
            const style = Math.floor(rnd() * 4);
            name = (style === 0 ? `${first}${last}` : style === 1 ? `${first}${last.charAt(0)}` : style === 2 ? `${first}_${last}` : `${first}${last}${Math.floor(rnd() * 90 + 10)}`).slice(0, 32);
          }
          const norm = name.trim().toLowerCase();
          if (norm.length >= 2 && !usedNames.has(norm) && !takenNames.has(norm)) {
            usedNames.add(norm);
            return name;
          }
        }
        const fallback = `LeonidaPlayer${i + 1}`;
        usedNames.add(fallback.toLowerCase());
        return fallback;
      };
      type BotDef = { playerKey: string; gamertag: string; displayName: string; platform: "PS5" | "Xbox" | "Both"; region: string; playstyle: string; bio: string; avatarId: string; callingCard: string; xp: number; createdAt: Date };
      const bots: BotDef[] = [];
      for (let i = 0; i < 200; i++) {
        const gamertag = gamertagFor(i);
        const isRealName = i % 5 >= 3;
        const medium = i % 20 === 7;
        bots.push({
          playerKey: `bot-${gamertag.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          gamertag,
          displayName: isRealName ? gamertag.replace(/[_0-9]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim() : "",
          platform: i % 20 < 9 ? "PS5" : i % 20 < 16 ? "Xbox" : "Both",
          region: pick(REGIONS),
          playstyle: pick(PLAYSTYLES),
          bio: pick(BIOS),
          // Every seeded member has an avatar — no grey placeholders.
          avatarId: pick(AVATARS),
          callingCard: rnd() < 0.45 ? pick(FREE_CARDS) : "",
          xp: medium ? 220 + Math.floor(rnd() * 680) : 5 + Math.floor(rnd() * 176),
          createdAt: new Date(now - Math.floor(rnd() * 12 * 24 * 3600 * 1000) - 3600 * 1000),
        });
      }
      // Crews: 20 of them, sized to hold all 200 bots (8–13 each),
      // every one Public so real players can join straight away.
      const CREW_DEFS: { name: string; tag: string; motto: string; description: string }[] = [
        { name: "Neon Tide Cartel", tag: "NTC", motto: "Ride the neon tide.", description: "Casual crew for launch week — story runs, car meets and exploring Leonida together. Everyone welcome." },
        { name: "Palm Reaper Syndicate", tag: "PRS", motto: "Death by the beach.", description: "Vice City veterans and first-timers alike. We run events every weekend." },
        { name: "Keys Runner Collective", tag: "KRC", motto: "Causeway speed demons.", description: "Racers and road-trippers. If it has wheels, we line it up on the causeway." },
        { name: "Midnight Causeway Club", tag: "MCC", motto: "We own the night shift.", description: "Night owls only. Late sessions, chill drives, zero drama." },
        { name: "Sunset Strip Society", tag: "SSS", motto: "Golden hour, every hour.", description: "Photographers, cruisers and story lovers. Slow pace, good company." },
        { name: "Leonida Lowriders", tag: "LLR", motto: "Low and slow.", description: "Car meet crew — builds, cruises and clean laps around the bay." },
        { name: "Gator Bait Garage", tag: "GBG", motto: "Built in the swamp.", description: "Off-road and backwater explorers. The Everglades side of Leonida is home." },
        { name: "Vice City Vandals", tag: "VCV", motto: "Chaos, but make it fashion.", description: "High-energy crew for players who like their sessions loud. Missions first, mayhem second." },
        { name: "Harbor Lights Union", tag: "HLU", motto: "Every port, every night.", description: "Boats, docks and bay runs. A friendly crew for explorers." },
        { name: "Neon Reef Runners", tag: "NRR", motto: "Fast under the neon.", description: "Mixed-platform crew chasing 100% — missions, collectibles, the lot." },
        { name: "Boardwalk Royalty", tag: "BWR", motto: "The strip is ours.", description: "Social crew — car meets on the boardwalk every Friday night." },
        { name: "Swamp Fox Squadron", tag: "SFS", motto: "Quiet in the mangroves.", description: "Small, steady crew. Story co-op energy and Easter egg hunting." },
        { name: "Turbo Flamingos", tag: "TFL", motto: "Pink, loud, fast.", description: "The flamingo crew. Racing events, silly builds, serious pace." },
        { name: "Canal Crawler Crew", tag: "CCC", motto: "Every waterway mapped.", description: "Completionists mapping every canal and shortcut in Leonida." },
        { name: "Storm Surge Society", tag: "SSG", motto: "We drive into the hurricane.", description: "Weather chasers and stunt drivers. If it storms, we roll out." },
        { name: "Palmetto Prowlers", tag: "PPR", motto: "Shadows and palm trees.", description: "Steady grinders — daily sessions, missions and money runs when online lands." },
        { name: "Ocean Drive Originals", tag: "ODO", motto: "First on Ocean Drive.", description: "Day-one players keeping the Ocean Drive meet alive since launch." },
        { name: "Mangrove Cartel", tag: "MGC", motto: "Rooted deep.", description: "Laid-back crew out past the city lights. New players very welcome." },
        { name: "Synthwave Saints", tag: "SWS", motto: "Neon is a lifestyle.", description: "Aesthetic builds, night drives and photo mode addicts." },
        { name: "Bayfront Bandits", tag: "BFB", motto: "Take the bay, keep the change.", description: "Event-focused crew — we host, we show up, we climb the board." },
      ];
      const CREW_SIZES = [13, 11, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 9, 9, 9, 9];
      const CREW_COLORS = ["#FF2E88", "#2DD4BF", "#FFD166", "#7DF9FF", "#9B5DE5", "#FF7A00", "#39E07A", "#5B2A86"];
      const CREW_EMBLEMS = ["sunset", "crown", "serpent", "diamond", "wave"];
      const CLAN_CARDS = ["clan-vice", "clan-heat", "skull-strip", "keys-runner", "palm-reaper"];
      const existingClanNames = new Set((await db.select().from(schema.clans)).map((c) => c.name.trim().toLowerCase()));
      const existingMembersSeed = await db.select().from(schema.clanMembers);
      const memberPairsSeed = new Set(existingMembersSeed.map((m) => `${m.clanId}:${m.playerKey}`));
      const seasonKey = seasonKeyOf(new Date());
      let profilesCreated = 0;
      let crewsCreated = 0;
      let botIdx = 0;
      const botCrewId = new Map<string, number>();
      for (let ci = 0; ci < CREW_DEFS.length; ci++) {
        const def = CREW_DEFS[ci] as (typeof CREW_DEFS)[number];
        const size = CREW_SIZES[ci] ?? 10;
        const members = bots.slice(botIdx, botIdx + size);
        botIdx += size;
        if (members.length === 0) continue;
        let clanId = 0;
        if (!existingClanNames.has(def.name.trim().toLowerCase())) {
          const inserted = await db
            .insert(schema.clans)
            .values({
              name: def.name,
              tag: def.tag,
              color: pick(CREW_COLORS),
              emblem: pick(CREW_EMBLEMS),
              motto: def.motto,
              description: def.description,
              platform: ci % 4 === 1 ? "PS5" : ci % 4 === 3 ? "Xbox" : "Both",
              region: pick(REGIONS),
              language: "English",
              playstyle: pick(PLAYSTYLES),
              privacy: "Public",
              maxMembers: 50,
              callingCard: rnd() < 0.6 ? pick(CLAN_CARDS) : "",
              createdAt: new Date(now - Math.floor(rnd() * 10 * 24 * 3600 * 1000) - 7200 * 1000),
            })
            .returning({ id: schema.clans.id });
          clanId = inserted[0]?.id ?? 0;
          crewsCreated++;
        } else {
          const rows = await db.select().from(schema.clans);
          clanId = rows.find((c) => c.name.trim().toLowerCase() === def.name.trim().toLowerCase())?.id ?? 0;
        }
        for (let mi = 0; mi < members.length; mi++) {
          const bot = members[mi] as BotDef;
          botCrewId.set(bot.playerKey, clanId);
          if (memberPairsSeed.has(`${clanId}:${bot.playerKey}`)) continue;
          await db.insert(schema.clanMembers).values({
            clanId,
            playerKey: bot.playerKey,
            gamertag: bot.gamertag,
            platform: bot.platform,
            role: mi === 0 ? "Leader" : mi === 1 ? "Co-Leader" : mi < 4 ? "Elder" : rnd() < 0.8 ? "Member" : "Recruit",
            squad: "",
            joinedAt: new Date(bot.createdAt.getTime() + Math.floor(rnd() * 48 * 3600 * 1000)),
          });
        }
      }
      // Profiles + their equipped cosmetics. Every write is guarded
      // by what already exists, so re-running the seed after a
      // partial run fills the gaps instead of duplicating rows.
      const existingKeysSeed = new Set(existing.map((p) => p.playerKey));
      const existingOwnedSeed = new Set((await db.select().from(schema.ownedItems)).map((o) => `${o.ownerId}:${o.itemId}`));
      const existingPointRefsSeed = new Set((await db.select({ sourceRef: schema.rankPointEvents.sourceRef }).from(schema.rankPointEvents)).map((r) => r.sourceRef));
      for (const bot of bots) {
        if (!existingKeysSeed.has(bot.playerKey)) {
          await db.insert(schema.profiles).values({
            playerKey: bot.playerKey,
            gamertag: bot.gamertag,
            platform: bot.platform,
            region: bot.region,
            playstyle: bot.playstyle,
            bio: bot.bio,
            displayName: bot.displayName,
            avatarId: bot.avatarId,
            callingCard: bot.callingCard,
            credits: STARTING_CREDITS,
            email: "",
            createdAt: bot.createdAt,
          });
          profilesCreated++;
        }
        if (bot.avatarId && !existingOwnedSeed.has(`${bot.playerKey}:avatar-${bot.avatarId}`)) {
          await db.insert(schema.ownedItems).values({ ownerType: "personal", ownerId: bot.playerKey, itemId: `avatar-${bot.avatarId}`, equipped: 1 });
        }
        if (bot.callingCard && !existingOwnedSeed.has(`${bot.playerKey}:card-${bot.callingCard}`)) {
          await db.insert(schema.ownedItems).values({ ownerType: "personal", ownerId: bot.playerKey, itemId: `card-${bot.callingCard}`, equipped: 1 });
        }
        // Season Rank Points, chunked into realistic in-app actions.
        if (existingPointRefsSeed.has(`botseed:${bot.playerKey}:0`)) continue;
        let remaining = bot.xp;
        let chunkIdx = 0;
        const CHUNKS: { points: number; source: string; reason: string }[] = [
          { points: 25, source: "egg", reason: "Easter egg confirmed in the tracker" },
          { points: 15, source: "eventAttend", reason: "Attended a community event" },
          { points: 15, source: "event", reason: "Attended a community event" },
          { points: 5, source: "feedpost", reason: "Feed post published" },
        ];
        while (remaining > 0) {
          const chunk = CHUNKS.find((c) => c.points <= remaining) ?? CHUNKS[CHUNKS.length - 1] as (typeof CHUNKS)[number];
          await db.insert(schema.rankPointEvents).values({
            clanId: botCrewId.get(bot.playerKey) ?? 0,
            playerKey: bot.playerKey,
            gamertag: bot.gamertag,
            points: chunk.points,
            source: chunk.source,
            sourceRef: `botseed:${bot.playerKey}:${chunkIdx}`,
            reason: chunk.reason,
            seasonKey,
            verifiedBy: "system",
            createdAt: new Date(bot.createdAt.getTime() + Math.floor(rnd() * 5 * 24 * 3600 * 1000)),
          });
          remaining -= chunk.points;
          chunkIdx++;
        }
      }
      // Feed life: posts from about a third of the bots, spread over
      // the last four days, then likes and comments from the others.
      const POST_BODIES: { kind: string; title: string; body: string }[] = [
        { kind: "Post", title: "", body: "Launch day finally. See you all in Leonida." },
        { kind: "Discussion", title: "Where is everyone starting first?", body: "Vice City strip or straight out to the Keys? I can't decide where to drive first." },
        { kind: "Gameplay", title: "", body: "The causeway at sunset is unreal. This game is beautiful." },
        { kind: "Post", title: "", body: "Pre-load done, snacks ready. Longest wait ever and it's nearly over." },
        { kind: "Question", title: "Best first car to save for?", body: "What is everyone saving for first? I want a classic convertible for Ocean Drive." },
        { kind: "Car Meet", title: "", body: "Small meet on the boardwalk tonight if anyone is around — clean builds only." },
        { kind: "Discussion", title: "Story first or explore first?", body: "Are you beelining the story or getting lost in Leonida for the first ten hours?" },
        { kind: "Meme", title: "", body: "Me telling my crew I'll be online at 6 and showing up at 9 with snacks." },
        { kind: "Funny", title: "", body: "Drove into the canal within four minutes of starting. Four. Minutes." },
        { kind: "Post", title: "", body: "My crew is ready. Launch weekend is going to be chaos in the best way." },
        { kind: "Tutorial", title: "Turn off motion blur, thank me later", body: "First settings to change: motion blur off, camera shake low, brightness up a touch for night driving." },
        { kind: "Discussion", title: "Which district are you claiming?", body: "Every crew needs a home turf. We're taking the bayfront." },
        { kind: "Post", title: "", body: "That new trailer shot of the Keys at dawn lives in my head rent free." },
        { kind: "Gameplay", title: "", body: "Night drives hit different in this game. The neon reflections on wet roads are perfect." },
        { kind: "Question", title: "Anyone else mapping Easter eggs already?", body: "Starting a list of weird spots to check on day one. Drop your theories." },
        { kind: "Post", title: "", body: "Took the day off work for launch. No regrets." },
        { kind: "Car Meet", title: "", body: "Lowrider night this Saturday — bring your cleanest build." },
        { kind: "Discussion", title: "Dual protagonists — whose story first?", body: "If we get a choice at any point, who are you following first?" },
        { kind: "Funny", title: "", body: "My GPS in real life now disappoints me. It doesn't have the Vice City voice in my head." },
        { kind: "Post", title: "", body: "Recruiting two more for our crew before the weekend events start — all levels welcome." },
        { kind: "Meme", title: "", body: "Nobody: … Me at 3am: one more drive around the block." },
        { kind: "Gameplay", title: "", body: "Found a ramp near the docks that sends you clean over the canal. You are welcome." },
        { kind: "Discussion", title: "What is your first money move?", body: "Saving everything, or spending on a garage and a fast car immediately?" },
        { kind: "Post", title: "", body: "The soundtrack on night drives is going to carry this whole game for me." },
      ];
      const COMMENT_BODIES = ["Let's gooo, see you there.", "This is the way.", "Instant classic.", "Adding this to my day-one list.", "Vice City forever.", "My crew needs to see this.", "Facts. Same plan here.", "The Keys at dawn is my first stop too.", "Clean build, respect.", "Saving this for launch weekend.", "This is why I joined this community.", "Count me in for the meet.", "Underrated take, honestly.", "Day one can't come fast enough.", "Leonida is going to eat my whole month.", "Big facts.", "Screenshot or it didn't happen (kidding — nice find).", "Our crew was just talking about this."];
      const posterBots = bots.filter((_, i) => i % 3 === 0);
      const postIds: { id: number; authorKey: string; createdAt: Date }[] = [];
      let postsCreated = 0;
      if (botPostsExistSeed) {
        // A previous run already posted these — reuse the rows so
        // the likes / comments phases below can still complete.
        for (const p of allPostsSeed) {
          if (p.authorKey.startsWith("bot-")) postIds.push({ id: p.id, authorKey: p.authorKey, createdAt: p.createdAt });
        }
      }
      for (let pi = 0; pi < (botPostsExistSeed ? 0 : posterBots.length); pi++) {
        const bot = posterBots[pi] as BotDef;
        const content = POST_BODIES[pi % POST_BODIES.length] as (typeof POST_BODIES)[number];
        const createdAt = new Date(now - Math.floor(rnd() * 4 * 24 * 3600 * 1000) - 600 * 1000);
        const inserted = await db
          .insert(schema.feedPosts)
          .values({
            authorKey: bot.playerKey,
            author: bot.gamertag,
            kind: content.kind as typeof schema.feedPosts.$inferInsert.kind,
            title: content.title,
            body: content.body,
            mediaUrl: "",
            auto: 0,
            sourceName: "",
            sourceUrl: "",
            createdAt,
          })
          .returning({ id: schema.feedPosts.id });
        const id = inserted[0]?.id ?? 0;
        if (id) {
          postIds.push({ id, authorKey: bot.playerKey, createdAt });
          postsCreated++;
        }
      }
      // Likes: a handful of bots like each seeded post, and a few
      // like posts that were already on the Feed.
      let likesCreated = 0;
      const botLikesExistSeed = (await db.select().from(schema.feedReactions)).some((r) => r.playerKey.startsWith("bot-"));
      const likePost = async (postId: number, liker: BotDef) => {
        await db.insert(schema.feedReactions).values({ postId, playerKey: liker.playerKey, createdAt: new Date(now - Math.floor(rnd() * 24 * 3600 * 1000)) });
        likesCreated++;
      };
      for (const post of botLikesExistSeed ? [] : postIds) {
        const likerCount = 3 + Math.floor(rnd() * 10);
        const shuffled = [...bots].sort(() => rnd() - 0.5);
        let given = 0;
        for (const liker of shuffled) {
          if (given >= likerCount) break;
          if (liker.playerKey === post.authorKey) continue;
          await likePost(post.id, liker);
          given++;
        }
      }
      const preExisting = (await db.select().from(schema.feedPosts)).filter((p) => !p.authorKey.startsWith("bot-")).slice(0, 12);
      for (const post of botLikesExistSeed ? [] : preExisting) {
        const likerCount = 2 + Math.floor(rnd() * 4);
        const shuffled = [...bots].sort(() => rnd() - 0.5).slice(0, likerCount);
        for (const liker of shuffled) await likePost(post.id, liker);
      }
      // Comments: bots replying to each other's posts.
      let commentsCreated = 0;
      const botCommentsExistSeed = (await db.select().from(schema.feedComments)).some((c) => c.authorKey.startsWith("bot-"));
      for (let ci2 = 0; ci2 < (botCommentsExistSeed ? 0 : 48) && postIds.length > 0; ci2++) {
        const post = postIds[Math.floor(rnd() * postIds.length)] as (typeof postIds)[number];
        const commenter = bots[Math.floor(rnd() * bots.length)] as BotDef;
        if (commenter.playerKey === post.authorKey) continue;
        await db.insert(schema.feedComments).values({
          postId: post.id,
          authorKey: commenter.playerKey,
          author: commenter.gamertag,
          body: pick(COMMENT_BODIES),
          parentId: 0,
          createdAt: new Date(Math.min(now - 300 * 1000, post.createdAt.getTime() + Math.floor(rnd() * 20 * 3600 * 1000))),
        });
        commentsCreated++;
      }
      // Follows: the seeded members follow each other, so every
      // profile carries a believable follower count in the low
      // hundreds (each follows ~140 of the other 199, so each ends
      // up followed by roughly 140 too) instead of sitting at zero.
      // ~28k rows: written with db.batch in chunks of 400 (a
      // sequential version took minutes), and any member who
      // already follows 100+ is skipped, so re-runs only fill gaps.
      const followedBySeed = new Map<string, number>();
      for (const f of allFollowsSeed) {
        if (f.followerKey.startsWith("bot-")) followedBySeed.set(f.followerKey, (followedBySeed.get(f.followerKey) ?? 0) + 1);
      }
      const followStmts: BatchItem<"sqlite">[] = [];
      for (const bot of bots) {
        if ((followedBySeed.get(bot.playerKey) ?? 0) >= 100) continue;
        const others = bots.filter((b) => b.playerKey !== bot.playerKey).sort(() => rnd() - 0.5).slice(0, 140);
        for (const target of others) {
          followStmts.push(db.insert(schema.profileFollows).values({
            followerKey: bot.playerKey,
            followingKey: target.playerKey,
            createdAt: new Date(bot.createdAt.getTime() + Math.floor(rnd() * 6 * 24 * 3600 * 1000)),
          }));
        }
      }
      let followsCreated = 0;
      for (let i = 0; i < followStmts.length; i += 400) {
        const chunk = followStmts.slice(i, i + 400);
        const [firstStmt, ...restStmts] = chunk;
        if (firstStmt) {
          await db.batch([firstStmt, ...restStmts]);
          followsCreated += chunk.length;
        }
      }
      ctx.invalidateQueries();
      return { ok: true as const, alreadySeeded: false, profilesCreated, crewsCreated, postsCreated, commentsCreated, likesCreated, followsCreated };
    },
  }),
} satisfies ActionsModule;
