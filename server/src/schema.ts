// ViceSunshine schema. Community-owned rows (bugs, clans, LFG, events,
// progress) live here alongside source-backed reference rows (news, patches)
// that the daily refresh action maintains.

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

const ts = (name: string) =>
  integer(name, { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());

export const news = sqliteTable("news", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  summary: text("summary").notNull().default(""),
  category: text("category", {
    enum: ["Official", "Patch", "Rumor", "Community"],
  })
    .notNull()
    .default("Community"),
  sourceName: text("source_name").notNull().default(""),
  sourceUrl: text("source_url").notNull().default(""),
  publishedAt: text("published_at").notNull().default(""),
  createdAt: ts("created_at"),
});

export const patches = sqliteTable("patches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  version: text("version").notNull(),
  releaseDate: text("release_date").notNull().default(""),
  sizePs5: text("size_ps5").notNull().default(""),
  sizeXbox: text("size_xbox").notNull().default(""),
  notes: text("notes").notNull().default("No official patch notes published"),
  sourceUrl: text("source_url").notNull().default(""),
  createdAt: ts("created_at"),
});

export const bugs = sqliteTable("bugs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  platform: text("platform", { enum: ["PS5", "Xbox", "Both"] })
    .notNull()
    .default("PS5"),
  description: text("description").notNull().default(""),
  status: text("status", {
    enum: [
      "Reported",
      "Confirmed",
      "Investigating",
      "Fixed",
      "Cannot Reproduce",
    ],
  })
    .notNull()
    .default("Reported"),
  fixedIn: text("fixed_in").notNull().default(""),
  workaround: text("workaround").notNull().default(""),
  votes: integer("votes").notNull().default(0),
  reporter: text("reporter").notNull().default(""),
  flagged: integer("flagged").notNull().default(0),
  // Provenance for automatic finds (migration 0058): bugs the
  // automatic refresh discovers online — from Rockstar / GTA
  // sources, news and creators / influencers — carry the
  // publication that reported them and the article / video URL,
  // copied verbatim from the search result, plus auto = 1.
  // Community reports filed in the tracker itself have auto = 0
  // and empty source fields; their reporter is the player.
  sourceName: text("source_name").notNull().default(""),
  sourceUrl: text("source_url").notNull().default(""),
  auto: integer("auto").notNull().default(0),
  createdAt: ts("created_at"),
});

export const bugReports = sqliteTable("bug_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bugId: integer("bug_id").notNull(),
  reporterKey: text("reporter_key").notNull(),
  reason: text("reason").notNull().default(""),
  createdAt: ts("created_at"),
});

// One "I have this too" vote per signed-in player per bug — the
// row's existence IS the vote, so a player can never vote twice.
export const bugVotes = sqliteTable("bug_votes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bugId: integer("bug_id").notNull(),
  playerKey: text("player_key").notNull(),
  createdAt: ts("created_at"),
});

export const eggs = sqliteTable("eggs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  location: text("location").notNull().default(""),
  howTo: text("how_to").notNull().default(""),
  status: text("status", { enum: ["Confirmed", "Reported", "Rumor"] })
    .notNull()
    .default("Reported"),
  x: real("x").notNull().default(50),
  y: real("y").notNull().default(50),
  submitterKey: text("submitter_key").notNull().default(""),
  // Provenance for finds the automatic refresh discovers online
  // (migration 0036): the publication that reported the find and the
  // article URL, copied verbatim from the search result. Empty for
  // community-submitted finds.
  sourceName: text("source_name").notNull().default(""),
  sourceUrl: text("source_url").notNull().default(""),
  createdAt: ts("created_at"),
});

// Everything related to ONE Easter egg, gathered automatically by
// refreshEggContent: YouTube videos, written guides and articles
// about that specific find, each linked to its original source
// (never re-hosted). Shown on that egg's own detail tab.
export const eggMedia = sqliteTable("egg_media", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eggId: integer("egg_id").notNull(),
  kind: text("kind", { enum: ["Video", "Guide", "Article"] })
    .notNull()
    .default("Video"),
  title: text("title").notNull(),
  url: text("url").notNull().default(""),
  sourceName: text("source_name").notNull().default(""),
  createdAt: ts("created_at"),
});

export const mapPins = sqliteTable("map_pins", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  layer: text("layer", {
    enum: [
      "Missions",
      "Easter Eggs",
      "Collectibles",
      "Activities",
      "Shops",
      "Safehouses",
    ],
  })
    .notNull()
    .default("Activities"),
  detail: text("detail").notNull().default(""),
  x: real("x").notNull().default(50),
  y: real("y").notNull().default(50),
  createdAt: ts("created_at"),
});

export const guides = sqliteTable("guides", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  category: text("category").notNull().default("Beginner"),
  body: text("body").notNull().default(""),
  author: text("author").notNull().default(""),
  createdAt: ts("created_at"),
});

export const profiles = sqliteTable("profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerKey: text("player_key").notNull(),
  gamertag: text("gamertag").notNull(),
  platform: text("platform", { enum: ["PS5", "Xbox", "Both"] })
    .notNull()
    .default("PS5"),
  region: text("region").notNull().default(""),
  playstyle: text("playstyle").notNull().default(""),
  reputation: integer("reputation").notNull().default(0),
  premium: integer("premium").notNull().default(0),
  psnId: text("psn_id").notNull().default(""),
  xboxId: text("xbox_id").notNull().default(""),
  // Rockstar Social Club ID (migration 0045) — OPTIONAL, typed in by
  // the player like the other linked IDs (there is no Rockstar
  // sign-in for a fan site). Visibility is its own choice and defaults
  // to PRIVATE (show_rockstar 0): private means only the player and
  // their crew can see it; public means everyone can see and copy it.
  rockstarId: text("rockstar_id").notNull().default(""),
  discordId: text("discord_id").notNull().default(""),
  otherLinks: text("other_links").notNull().default(""),
  showPsn: integer("show_psn").notNull().default(1),
  showXbox: integer("show_xbox").notNull().default(1),
  showRockstar: integer("show_rockstar").notNull().default(0),
  showDiscord: integer("show_discord").notNull().default(1),
  showOther: integer("show_other").notNull().default(1),
  // Vice Credits personal wallet. New profiles start at 500 (see
  // STARTING_CREDITS in actions.ts); the column default covers profiles
  // created before the credits system existed.
  credits: integer("credits").notNull().default(500),
  badge: text("badge").notNull().default(""),
  bannerColor: text("banner_color").notNull().default(""),
  nameColor: text("name_color").notNull().default(""),
  themeAccent: text("theme_accent").notNull().default(""),
  avatarFrame: text("avatar_frame").notNull().default(""),
  avatarId: text("avatar_id").notNull().default(""),
  // LEGACY avatar effect column (migration 0027): Avatars and
  // Avatar Effects were REMOVED from ViceSunshine entirely
  // (migration 0071) — the catalogue sections, their equip state
  // and every render are gone, and this column was cleared to ""
  // for every profile. Nothing writes or reads it anymore; it
  // stays only so existing rows keep loading. The same applies to
  // the legacy personal-cosmetic columns badge / callingCard /
  // themeAccent / avatarId below and above: personal customisation
  // no longer exists — customisation belongs to crews (see the
  // clans table's badge / themeAccent / callingCard / emblem /
  // color columns). A profile's picture is the member's own
  // uploaded picture (customAvatarBlobKey) or the default avatar.
  avatarEffect: text("avatar_effect").notNull().default(""),
  // Custom avatar picture (migration 0032): the player's OWN uploaded
  // profile picture, stored as an owned blob. Every upload is checked
  // by automatic moderation BEFORE it is stored (see
  // uploadCustomAvatar) — nude or illegal pictures are rejected and
  // never reach this column. "" = no custom picture; the equipped
  // catalogue avatar (avatar_id) or initials show instead. A custom
  // picture takes precedence over avatar_id while set.
  customAvatarBlobKey: text("custom_avatar_blob_key").notNull().default(""),
  // Custom banner media (migration 0063): the player's OWN uploaded
  // profile banner — a picture (JPG/PNG, checked by automatic
  // moderation BEFORE storage, like the avatar picture) or a short
  // video (MP4/WebM) — stored as an owned blob. While set it takes
  // precedence over the calling card in the profile banner;
  // choosing a calling card (equipCosmetic callingCard) or removing
  // the media clears it. "" = no custom banner media.
  bannerBlobKey: text("banner_blob_key").notNull().default(""),
  bannerMediaType: text("banner_media_type").notNull().default(""),
  // Discord-style custom status text (migration 0032): a short line
  // the player sets from the Change Online Status sheet ("Set a
  // custom status"), shown in the Add Status bubble on their profile.
  // Screened by the text moderator before it is stored.
  customStatus: text("custom_status").notNull().default(""),
  // Presence (migration 0028): the status the player CHOSE in
  // Settings (Online / Away / Do Not Disturb / Ghost / Offline) and
  // when they were last active in ViceSunshine. What OTHER players see
  // is derived server-side (effectivePresence): Ghost always reads
  // as Offline to others, and anyone inactive for over 5 minutes
  // reads as Offline whatever they chose.
  presence: text("presence", {
    enum: ["Online", "Away", "Do Not Disturb", "Ghost", "Offline"],
  })
    .notNull()
    .default("Online"),
  lastSeen: integer("last_seen", { mode: "timestamp_ms" }),
  // Equipped calling card design key (migration 0029): a wide,
  // bold COD-calling-card-style banner shown on the profile. "" =
  // none equipped.
  callingCard: text("calling_card").notNull().default(""),
  // Premium period anchor: the date the current Premium period
  // started. Null anchor = Premium not currently active.
  // premiumWeeksGranted is legacy: it counted the old weekly
  // 250-credit grants, which were removed Nov 22 2026 (no recurring
  // Vice Credits grant anymore) — the column stays so old rows keep
  // reading, and it is only ever reset to 0 now, never paid from.
  premiumSince: integer("premium_since", { mode: "timestamp_ms" }),
  premiumWeeksGranted: integer("premium_weeks_granted").notNull().default(0),
  // Set when the member cancels Premium: Premium stays active until
  // this instant — the end of the paid month — then lapses lazily on
  // the next wallet/profile read. Null = not cancelling.
  premiumEndsAt: integer("premium_ends_at", { mode: "timestamp_ms" }),
  // One-time Premium welcome award (owner's direction, Nov 22 2026):
  // going Premium pays 1,000 Vice Credits ONCE per account. 0 = not
  // yet paid, 1 = paid. Never reset — a lapse and renewal never pays
  // it a second time.
  premiumWelcomeGranted: integer("premium_welcome_granted").notNull().default(0),
  // Settings (migration 0021): display name + bio, contact email (for
  // receipts / support — there is no password sign-in in ViceSunshine;
  // identity is the device player key), privacy and notification
  // preferences, locale preferences, and Refer a Friend state.
  // referralCode is generated lazily from the player key; referredBy
  // holds the referrer's code (set once — one referral per friend);
  // referralDiscount = 1 while a banked 10% discount is waiting to be
  // applied at checkout (never stacks).
  bio: text("bio").notNull().default(""),
  displayName: text("display_name").notNull().default(""),
  // Location / website columns (migration 0047) — Location is a
  // live profile field again (owner's direction, Nov 21 2026:
  // leave Location, remove Website only): updateProfile accepts
  // and stores it, getProfile / getSocialProfile / getSettings
  // return it, and it renders under the bio. Website stays a
  // LEGACY column: no action accepts or returns it, nothing
  // renders it, and updateProfile writes "" on every save so
  // stored values are cleared. The column stays only so existing
  // rows keep loading.
  location: text("location").notNull().default(""),
  website: text("website").notNull().default(""),
  // Birth date (migration 0050), stored as YYYY-MM-DD text, "" when
  // unset. Private by default: only ever returned by getProfile to
  // the owner themself (the X-style Edit profile sheet's Birth date
  // row) — UNLESS the owner flips the Birth date visibility switch
  // on (showDob below), which is the one way it shows publicly.
  dob: text("dob").notNull().default(""),
  // Per-field visibility switches (migration 0066, owner's
  // direction Nov 21 2026): a switch button in Edit profile on the
  // Birth date and Location fields decides whether that field
  // shows on the public profile. Bio deliberately has NO switch.
  // showDob starts OFF (birth dates were never public before), so
  // existing rows keep exactly the privacy they had; showLocation
  // starts ON because a set location already showed publicly.
  showDob: integer("show_dob").notNull().default(0),
  showLocation: integer("show_location").notNull().default(1),
  // Number visibility switches (migration 0087, owner's
  // direction Nov 22 2026): the eye toggles on the Profile's
  // Personal Wallet and Events Attended boxes. Both start ON
  // (the numbers showed before, so existing rows keep exactly
  // what they had). OFF hides the number: the wallet balance —
  // which only the owner ever receives — renders masked on the
  // owner's own profile, and the Events Attended count stops
  // being sent to other viewers at all (they see "Hidden").
  showWalletNumber: integer("show_wallet_number").notNull().default(1),
  showEventsNumber: integer("show_events_number").notNull().default(1),
  // LEGACY personal tag column (migration 0060) — no longer read
  // or written by any action. The personal tag was removed
  // (owner's direction, Nov 21 2026): there is no tag on a profile.
  // The Crew tag lives on the crew itself (clans.tag + clans.color,
  // chosen when the crew is created) and is derived live from the
  // member's crew membership, so it appears in front of their name
  // while they are in the crew and disappears when they leave.
  // The column stays only so existing rows keep loading.
  clanTag: text("clan_tag").notNull().default(""),
  // Username-change tracking (migration 0051) for the About
  // account sheet: how many times the gamertag has actually been
  // renamed (account creation is not a change) and when the last
  // rename happened. Counted in saveProfile / updateProfile /
  // saveSettings via usernameChangeFields.
  usernameChanges: integer("username_changes").notNull().default(0),
  lastUsernameChangeAt: integer("last_username_change_at", { mode: "timestamp_ms" }),
  displayNameChangedAt: integer("display_name_changed_at", { mode: "timestamp_ms" }),
  clanTagChangedAt: integer("clan_tag_changed_at", { mode: "timestamp_ms" }),
  email: text("email").notNull().default(""),
  // Phone number (migration 0052): optional, stored as typed; lets
  // the player sign in with their phone number + password as well
  // as their Gmail + password. Unique across accounts when set
  // (enforced in createAccount / saveSettings, like the email).
  phone: text("phone").notNull().default(""),
  // 1 once the account's email has been confirmed with a code sent
  // to that inbox (migration 0052, email_codes below). Accounts
  // created before verification existed start at 0 and can confirm
  // any time from Settings.
  emailVerified: integer("email_verified").notNull().default(0),
  profilePrivate: integer("profile_private").notNull().default(0),
  showClan: integer("show_clan").notNull().default(1),
  notifyReposts: integer("notify_reposts").notNull().default(1),
  notifyParty: integer("notify_party").notNull().default(1),
  language: text("language").notNull().default("en"),
  currency: text("currency").notNull().default(""),
  timezone: text("timezone").notNull().default(""),
  referralCode: text("referral_code").notNull().default(""),
  referredBy: text("referred_by").notNull().default(""),
  referralDiscount: integer("referral_discount").notNull().default(0),
  // Discord-style profile (migration 0023): a private note only the
  // owner ever sees (never returned for any other player, never shown
  // in the directory). The wishlist column is legacy: it held Shop
  // wishlist item ids before the Shop was removed (customisation is
  // free now) — nothing reads or writes it anymore.
  privateNote: text("private_note").notNull().default(""),
  wishlist: text("wishlist").notNull().default(""),
  // Account credentials (migration 0048): the password set at
  // sign-up, stored ONLY as a salted PBKDF2 hash (never the password
  // itself, never returned by any action). "" = accounts created
  // before passwords existed — they set one from sign-up or Settings.
  // The password is what lets a player sign back in on a new device
  // and recover everything saved to their account; day-to-day
  // sign-in on their own device stays the device player key.
  passwordHash: text("password_hash").notNull().default(""),
  // 2-step verification (migration 0048): an authenticator-app TOTP
  // secret (base32). Stored when setup starts; two_factor_enabled
  // flips to 1 only after the player proves the setup by entering a
  // valid code. Backup codes are stored ONLY as SHA-256 hashes (JSON
  // array) — the plain codes are shown to the player exactly once.
  twoFactorSecret: text("two_factor_secret").notNull().default(""),
  twoFactorEnabled: integer("two_factor_enabled").notNull().default(0),
  twoFactorBackupHashes: text("two_factor_backup_hashes").notNull().default(""),
  createdAt: ts("created_at"),
});

// One live email code at a time per email + purpose (migration
// 0052): a 6-digit code emailed for confirming an email address
// (purpose "verify") or resetting a password (purpose "reset").
// Only the SHA-256 hash is stored — the plain code exists only in
// the email itself. expires_at / created_at are epoch milliseconds;
// attempts counts wrong guesses (the code dies at 5).
export const emailCodes = sqliteTable("email_codes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().default(""),
  purpose: text("purpose").notNull().default("verify"),
  codeHash: text("code_hash").notNull().default(""),
  expiresAt: integer("expires_at").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  createdAt: integer("created_at").notNull().default(0),
});

// Players this player has blocked: their Feed posts are hidden from
// the blocker, and they cannot start a Party Call with the blocker or
// send them a Party Call invite.
export const blockedUsers = sqliteTable("blocked_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerKey: text("player_key").notNull(),
  blockedKey: text("blocked_key").notNull(),
  blockedGamertag: text("blocked_gamertag").notNull().default(""),
  createdAt: ts("created_at"),
});

export const clans = sqliteTable("clans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  tag: text("tag").notNull(),
  color: text("color").notNull().default("#FF2E88"),
  // Crew colour finish (migration 0080): the Premium Custom colour
  // tool's finish over the stored colour — "" = solid, or one of
  // chrome / gold / rose-gold / iridescent. The finish drives the
  // emblem tile and crew-card header gradient; the stored colour
  // stays the representative hex for tags and text accents.
  colorFinish: text("color_finish").notNull().default(""),
  emblem: text("emblem").notNull().default("shield"),
  motto: text("motto").notNull().default(""),
  description: text("description").notNull().default(""),
  // Crew rules (migration 0060): the crew's own house rules, written
  // by the Leader next to the bio (description) and shown on the
  // crew profile for members and visitors.
  rules: text("rules").notNull().default(""),
  // Crew customisation (migration 0071): customisation belongs to
  // CREWS now, never to individual profiles. The equipped crew badge
  // (a catalogue badge value, shown next to the crew name on the
  // crew card and crew page) and the equipped crew theme accent
  // (a catalogue theme hex, the crew page's accent theme). Only the
  // crew OWNER (Leader) equips them, from Crew Settings.
  badge: text("badge").notNull().default(""),
  themeAccent: text("theme_accent").notNull().default(""),
  // Join requirements (migration 0071): free-text lines the crew
  // writes (one per line — platform, activity, mic…), shown with
  // the rules on the crew page and again in the join flow. Edited
  // with the bio and rules in Crew Settings → Bio & Rules (Leader
  // and Co-Leaders), and first written in Create a Crew Step 2.
  requirements: text("requirements").notNull().default(""),
  platform: text("platform", { enum: ["PS5", "Xbox", "Both"] })
    .notNull()
    .default("Both"),
  region: text("region").notNull().default(""),
  language: text("language").notNull().default("English"),
  playstyle: text("playstyle").notNull().default("Chill"),
  privacy: text("privacy", {
    enum: ["Public", "Invite-Only", "Application"],
  })
    .notNull()
    .default("Public"),
  // LEGACY member-cap column: crew membership is UNLIMITED for
  // every crew now — nothing reads this as a limit, and new crews
  // store 0 ("no cap"). Kept only so existing rows keep loading.
  maxMembers: integer("max_members").notNull().default(0),
  eventsHeld: integer("events_held").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  faction: text("faction").notNull().default(""),
  factionPoints: integer("faction_points").notNull().default(0),
  // Clan wallet of Vice Credits (seasonal awards land here; clan
  // customisation itself is free in Customise). Plus equipped cosmetics.
  walletCredits: integer("wallet_credits").notNull().default(0),
  bannerStyle: text("banner_style").notNull().default(""),
  // Equipped clan calling card design key (migration 0029).
  callingCard: text("calling_card").notNull().default(""),
  // Crew card header background (migration 0072): the Leader's OWN
  // uploaded picture for the crew card's header area, stored as an
  // owned blob (JPG/PNG, moderation-checked before storage, cropped
  // to the header shape client-side before upload). "" = no custom
  // picture: the header background is then automatic — the crew's
  // equipped calling card artwork when it has one (that artwork IS
  // the crew's old banner, so nothing uploaded is ever lost), else
  // a gradient matched to the crew's colour.
  headerBlobKey: text("header_blob_key").notNull().default(""),
  emblemEffect: text("emblem_effect").notNull().default(""),
  nameColor: text("name_color").notNull().default(""),
  // When 1, Elders may also create / rename / reorder / delete this
  // clan's channels. Set by the Leader only; default off.
  eldersManageChannels: integer("elders_manage_channels").notNull().default(0),
  createdAt: ts("created_at"),
});

export const clanMembers = sqliteTable("clan_members", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clanId: integer("clan_id").notNull(),
  playerKey: text("player_key").notNull(),
  gamertag: text("gamertag").notNull(),
  platform: text("platform").notNull().default("PS5"),
  role: text("role", {
    enum: ["Leader", "Co-Leader", "Elder", "Member", "Recruit"],
  })
    .notNull()
    .default("Recruit"),
  squad: text("squad").notNull().default(""),
  joinedAt: ts("joined_at"),
});

export const clanApplications = sqliteTable("clan_applications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clanId: integer("clan_id").notNull(),
  playerKey: text("player_key").notNull(),
  gamertag: text("gamertag").notNull(),
  message: text("message").notNull().default(""),
  status: text("status", { enum: ["Pending", "Approved", "Declined"] })
    .notNull()
    .default("Pending"),
  // What kind of ask this row is (migration 0081): "application"
  // is the classic flow for Application (request-only) crews
  // (Leader or Co-Leader reviews it on the crew page). Private
  // (Invite-Only) crews file the SAME kind of row (owner's
  // definition, Nov 22 2026: "private" means send a request with
  // a text bar to explain why) — joinClan files the player's ask
  // here with their message, and only an approval puts them in.
  // "join_request" is the anti-spam flow for PUBLIC crews: a
  // player who has already used their one direct crew join this
  // week, or who was in this crew before and left, cannot join
  // directly — their ask lands as a card in the crew chat and
  // ONLY the Leader can accept or decline it.
  kind: text("kind", { enum: ["application", "join_request"] })
    .notNull()
    .default("application"),
  createdAt: ts("created_at"),
});

// Every successful crew join, kept forever (migration 0081) —
// clan_members rows are deleted when a player leaves or is
// kicked, so the anti-spam join rules need their own memory:
// (1) a player gets ONE direct crew join per rolling 7 days
// across all crews, and (2) a player who was in a crew before
// can never rejoin it directly — only by a Leader-accepted
// request. `how` records the door they came through: "direct"
// (walked into a public crew), "approved" (a Leader / Co-Leader
// accepted their application or join request) or "founded"
// (they created the crew). Seeded from clan_members by the
// migration, so current members' joins count from day one.
export const crewJoinHistory = sqliteTable("crew_join_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clanId: integer("clan_id").notNull(),
  playerKey: text("player_key").notNull(),
  gamertag: text("gamertag").notNull().default(""),
  how: text("how", { enum: ["direct", "approved", "founded"] })
    .notNull()
    .default("direct"),
  joinedAt: ts("joined_at"),
});

// Every VOLUNTARY crew leave, kept forever (migration 0083) —
// the owner's anti-spam rule is anchored on LEAVING: leaving ANY
// crew starts a 7-day wait before the player can join ANY crew
// again (not just the crew they left). Staying in a crew records
// nothing and changes nothing. Kicks are NOT recorded here —
// being removed is not leaving; a kicked player's way back into
// that one crew is already governed by the join history's
// "returning" rule. Written by leaveClan on every voluntary
// path: a member leaving, a Leader leaving (leadership passes
// on), and a sole Leader leaving (the crew dissolves).
export const crewLeaveHistory = sqliteTable("crew_leave_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clanId: integer("clan_id").notNull(),
  playerKey: text("player_key").notNull(),
  gamertag: text("gamertag").notNull().default(""),
  leftAt: ts("left_at"),
});

export const clanPosts = sqliteTable("clan_posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clanId: integer("clan_id").notNull(),
  // The key of a clan_channels text channel ("announcement" / "feed" /
  // "chat" by default; Leaders can create more).
  channel: text("channel").notNull().default("feed"),
  author: text("author").notNull(),
  body: text("body").notNull(),
  createdAt: ts("created_at"),
});

export const clanActivity = sqliteTable("clan_activity", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clanId: integer("clan_id").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target").notNull().default(""),
  reason: text("reason").notNull().default(""),
  createdAt: ts("created_at"),
});

export const squads = sqliteTable("squads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clanId: integer("clan_id").notNull(),
  name: text("name").notNull(),
  leadGamertag: text("lead_gamertag").notNull().default(""),
  focus: text("focus").notNull().default(""),
  createdAt: ts("created_at"),
});

export const lfgPosts = sqliteTable("lfg_posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  authorKey: text("author_key").notNull(),
  author: text("author").notNull(),
  title: text("title").notNull(),
  activity: text("activity").notNull().default("Explore"),
  platform: text("platform", { enum: ["PS5", "Xbox", "Both"] })
    .notNull()
    .default("PS5"),
  whenText: text("when_text").notNull().default(""),
  timezone: text("timezone").notNull().default(""),
  language: text("language").notNull().default("English"),
  skillLevel: text("skill_level").notNull().default("Any"),
  micRequired: integer("mic_required").notNull().default(0),
  spotsTotal: integer("spots_total").notNull().default(4),
  spotsFilled: integer("spots_filled").notNull().default(1),
  closed: integer("closed").notNull().default(0),
  priority: integer("priority").notNull().default(0),
  createdAt: ts("created_at"),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  type: text("type").notNull().default("Car Meet"),
  startsAt: text("starts_at").notNull().default(""),
  timezone: text("timezone").notNull().default("America/New_York"),
  platform: text("platform", { enum: ["PS5", "Xbox", "Both"] })
    .notNull()
    .default("Both"),
  maxPlayers: integer("max_players").notNull().default(16),
  description: text("description").notNull().default(""),
  rules: text("rules").notNull().default(""),
  prize: text("prize").notNull().default("Bragging rights + site badge"),
  host: text("host").notNull().default(""),
  lobbyDetails: text("lobby_details").notNull().default(""),
  lobbyLink: text("lobby_link").notNull().default(""),
  clanId: integer("clan_id"),
  // Community Events discovery (migration 0030): Public events are
  // visible to everyone; Private events are visible only to members
  // of the host clan (clan_id) and the host. Hashtags are stored
  // normalised ("carmeet race") so players can find events by name
  // OR by hashtag. host_clan_name snapshots the hosting clan's name.
  // "Request" (owner's direction, Nov 22 2026) is the third join
  // mode the hosting crew's Leader picks at creation: the event is
  // listed for everyone like a Public one, the host crew joins
  // right away, and players from OTHER crews ask to join — the
  // Leader approves or declines each ask (event_join_requests)
  // before the player is on the Going list and in the event chat.
  visibility: text("visibility", { enum: ["Public", "Private", "Request"] })
    .notNull()
    .default("Public"),
  hashtags: text("hashtags").notNull().default(""),
  hostClanName: text("host_clan_name").notNull().default(""),
  // Leader-uploaded event picture (migration 0056): a blob key
  // into ctx.blobs, moderated before storage like avatar uploads.
  // Empty = the event shows the standard events artwork instead.
  imageBlobKey: text("image_blob_key").notNull().default(""),
  // Private-event invite (migration 0031): a short code generated
  // when a Private event is created. Anyone with the code (or the
  // #event=CODE invite link carrying it) can view and join that one
  // private event; the code is only ever returned to the host and
  // the host clan's members, who share it with the people they
  // invite. Public events have no code.
  inviteCode: text("invite_code").notNull().default(""),
  results: text("results").notNull().default(""),
  createdAt: ts("created_at"),
});

export const rsvps = sqliteTable("rsvps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: integer("event_id").notNull(),
  playerKey: text("player_key").notNull(),
  gamertag: text("gamertag").notNull(),
  status: text("status", { enum: ["Going", "Maybe", "Can't Go"] })
    .notNull()
    .default("Going"),
  createdAt: ts("created_at"),
});

// The free weekly Community Event pass, per PLAYER (owner's
// direction, Nov 22 2026): when a crew creates an event, the free
// pass counts as used for EVERY member of that crew — one row per
// player, stamped with the moment of that crew's most recent
// event — and it resets a week later. This is what stops a Leader
// handing leadership to another member to keep creating free
// events: the new Leader's pass was used by the same event.
export const eventFreePasses = sqliteTable("event_free_passes", {
  playerKey: text("player_key").primaryKey(),
  lastUsedAt: ts("last_used_at"),
  lastTitle: text("last_title").notNull().default(""),
  lastClanId: integer("last_clan_id"),
});

// Asks to join a "Request"-mode Community Event (migration 0084).
// One row per player per event: Pending until the hosting crew's
// Leader approves (the player gets an RSVP Going and lands in the
// event chat) or declines (they cannot ask again). The host crew's
// own members never need a row — they join their crew's events
// directly, like Public and Private ones.
export const eventJoinRequests = sqliteTable("event_join_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: integer("event_id").notNull(),
  playerKey: text("player_key").notNull(),
  gamertag: text("gamertag").notNull().default(""),
  status: text("status", { enum: ["Pending", "Approved", "Declined"] })
    .notNull()
    .default("Pending"),
  createdAt: ts("created_at"),
});

// "Not participate" taps on an event announcement card in a crew
// chat (migration 0084): one row per player per event means that
// player never sees that event's card in the crew chat again —
// the card disappears for them alone; everyone else still sees
// it, and the player can still join the event from the Events
// page whenever they want.
export const eventCardDismissals = sqliteTable("event_card_dismissals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: integer("event_id").notNull(),
  playerKey: text("player_key").notNull(),
  createdAt: ts("created_at"),
});

// Players the event's host (the hosting crew's Leader) has removed
// from one event (migration 0056). A kicked player cannot RSVP to
// that event again — being kicked out has to mean it.
export const eventKicked = sqliteTable("event_kicked", {
   id: integer("id").primaryKey({ autoIncrement: true }),
   eventId: integer("event_id").notNull(),
   playerKey: text("player_key").notNull(),
   gamertag: text("gamertag").notNull().default(""),
   createdAt: ts("created_at"),
 });

export const feedPosts = sqliteTable("feed_posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  authorKey: text("author_key").notNull(),
  author: text("author").notNull(),
  kind: text("kind", {
    enum: [
      "Post", "Screenshot", "Clip", "Funny", "Meme", "Streamer Clip",
      "Tutorial", "Gameplay", "Car Meet", "News", "Discussion",
      "Easter Egg Find", "Question", "News Discussion",
    ],
  })
    .notNull()
    .default("Post"),
  title: text("title").notNull().default(""),
  body: text("body").notNull(),
  mediaUrl: text("media_url").notNull().default(""),
  // Every media item on the post as a JSON array of URLs, first
  // item first (media_url above always holds the first one, so
  // older readers keep working). A post carries several photos
  // OR exactly one video — never a mix (owner's direction,
  // Nov 21 2026). Empty string = single-media post, read
  // media_url alone.
  mediaUrls: text("media_urls").notNull().default(""),
  // The post's optional attached link (the creator's "Add link"
  // on the Details / Share step). Rendered as a link chip under
  // the caption; never the media itself.
  linkUrl: text("link_url").notNull().default(""),
  // The post's optional location (migration 0078): the "Add
  // location" row on the creator's New post screen — a place
  // name the poster types, shown on the post in the Feed.
  location: text("location").notNull().default(""),
  // Editorial news picture (Automatic News posts only): the article's
  // own og:image, fetched by the refresh and stored as an owned blob.
  // Ben approved real pictures for news stories in the Feed (Nov 19,
  // 2026) — editorial use, credited to the source, linking out.
  imageBlobKey: text("image_blob_key").notNull().default(""),
  // Automatic posts (daily refreshFeedMedia): found on the web, never
  // re-uploaded — media_url/source_url point at the original source.
  auto: integer("auto").notNull().default(0),
  sourceName: text("source_name").notNull().default(""),
  sourceUrl: text("source_url").notNull().default(""),
  // Reposts: 0 = original post; otherwise the id of the ROOT original
  // post this row reposts (reposts of reposts resolve to the root, so
  // credit always lands on the original poster / source).
  repostOfId: integer("repost_of_id").notNull().default(0),
  shares: integer("shares").notNull().default(0),
  flagged: integer("flagged").notNull().default(0),
  createdAt: ts("created_at"),
});

export const feedReposts = sqliteTable("feed_reposts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // The ROOT original post that was reposted.
  postId: integer("post_id").notNull(),
  playerKey: text("player_key").notNull(),
  // The new feed_posts row created by the repost.
  repostPostId: integer("repost_post_id").notNull(),
  createdAt: ts("created_at"),
});

export const feedReactions = sqliteTable("feed_reactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id").notNull(),
  playerKey: text("player_key").notNull(),
  createdAt: ts("created_at"),
});

export const feedComments = sqliteTable("feed_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id").notNull(),
  authorKey: text("author_key").notNull(),
  author: text("author").notNull(),
  body: text("body").notNull(),
  // Instagram-style threaded replies (migration 0040): 0 = a
  // top-level comment; otherwise the id of the comment it replies
  // to (always a comment on the same post).
  parentId: integer("parent_id").notNull().default(0),
  createdAt: ts("created_at"),
});

// Likes on individual Feed comments (Instagram-style sheet).
export const feedCommentReactions = sqliteTable("feed_comment_reactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  commentId: integer("comment_id").notNull(),
  playerKey: text("player_key").notNull(),
  createdAt: ts("created_at"),
});

// One row per distinct viewer of a Feed / Clips post — the honest
// view count: how many different ViceSunshine players have actually
// seen the post in the Feed or as the active Clip. Never a guess,
// never the source platform's numbers.
export const feedViews = sqliteTable("feed_views", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id").notNull(),
  playerKey: text("player_key").notNull(),
  createdAt: ts("created_at"),
});

// Server-side record of a Feed save: this is the saver's Saved
// library for posts and clips (read back by listSavedFeedPosts), and
// the post author's profile analytics count real saves received from
// it too. One row per (post, saver); removed when the saver un-saves.
// Saving your own post IS recorded (it belongs in your own library);
// analytics always exclude self-saves from the author's counts.
export const feedSaves = sqliteTable("feed_saves", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id").notNull(),
  playerKey: text("player_key").notNull(),
  createdAt: ts("created_at"),
});

// Account saves (migration 0048): the player's Saved library and
// tracked goals, stored ON THE ACCOUNT (server-side, keyed by the
// account's player key) so they are never lost — they survive a new
// phone, a cleared browser, and signing back in on another device.
// kind is one of the Saved library kinds (news / guide / bug /
// mission / clan / egg / event), "tracked" (a Goals tracker item,
// whose full snapshot lives in meta as JSON) or "db" (a saved
// Database entry). ref_id is the saved row's id (for "tracked", the
// tracked item's own ref id; its kind/title/date/url ride in meta).
// The on-device localStorage lists remain as a fast cache and are
// merged with these rows, never the other way round.
export const accountSaves = sqliteTable("account_saves", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerKey: text("player_key").notNull(),
  kind: text("kind").notNull(),
  refId: integer("ref_id").notNull(),
  meta: text("meta").notNull().default(""),
  createdAt: ts("created_at"),
});

// Instagram-style Stories: a story is a photo / video / clip link
// (or text-only) with an optional text overlay and sticker label.
// Stories live for 24 hours from created_at, then every read path
// filters them out — they disappear, they are not archived.
export const stories = sqliteTable("stories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  authorKey: text("author_key").notNull(),
  author: text("author").notNull(),
  mediaUrl: text("media_url").notNull().default(""),
  // "image" | "video" | "embed" | "text" — derived server-side
  // from the media URL at posting time.
  mediaType: text("media_type").notNull().default("text"),
  text: text("text").notNull().default(""),
  sticker: text("sticker").notNull().default(""),
  createdAt: ts("created_at"),
});

export const storyViews = sqliteTable("story_views", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storyId: integer("story_id").notNull(),
  playerKey: text("player_key").notNull(),
  viewerGamertag: text("viewer_gamertag").notNull().default(""),
  createdAt: ts("created_at"),
});

export const storyLikes = sqliteTable("story_likes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storyId: integer("story_id").notNull(),
  playerKey: text("player_key").notNull(),
  createdAt: ts("created_at"),
});

export const storyReplies = sqliteTable("story_replies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storyId: integer("story_id").notNull(),
  playerKey: text("player_key").notNull(),
  author: text("author").notNull().default(""),
  body: text("body").notNull(),
  createdAt: ts("created_at"),
});

// Hide Story (migration 0049): one row per person the story author
// has hidden their stories from. player_key is the AUTHOR doing the
// hiding; hidden_key is the player who must not see that author's
// stories. Enforced in listStories (the author's groups never reach
// the hidden player) and in viewStory / toggleStoryLike /
// replyToStory (direct interaction is refused too). Uniqueness of
// the (player_key, hidden_key) pair is enforced in the action.
export const storyHiddenFrom = sqliteTable("story_hidden_from", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerKey: text("player_key").notNull(),
  hiddenKey: text("hidden_key").notNull(),
  createdAt: ts("created_at"),
});

// Story Highlights (migration 0047): a named collection of the
// player's OWN stories, pinned to their profile as a circle in the
// highlights row. Unlike live stories, highlight stories stay
// viewable past the 24-hour story window — that is the point of a
// highlight. The story rows themselves are never deleted, so a
// highlight is just an ordered set of references to them.
export const storyHighlights = sqliteTable("story_highlights", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerKey: text("player_key").notNull(),
  title: text("title").notNull(),
  // Chosen cover (migration 0068): the New highlight screen's big
  // circle. coverStoryId points at one of the player's own stories
  // picked as the cover; coverBlobKey is a picture uploaded from
  // the player's album for the cover. Both empty/0 = the default
  // cover (the highlight's first story picture).
  coverStoryId: integer("cover_story_id").notNull().default(0),
  coverBlobKey: text("cover_blob_key").notNull().default(""),
  createdAt: ts("created_at"),
});

export const storyHighlightItems = sqliteTable("story_highlight_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  highlightId: integer("highlight_id").notNull(),
  storyId: integer("story_id").notNull(),
  createdAt: ts("created_at"),
});

// Album media (migration 0069): pictures and videos a player has
// added to their own ViceSunshine album from their device album
// (album access is automatic — every device pick joins the album;
// there is no grant or toggle). The media bytes live in blobs
// (uploaded through uploadFeedMedia, which records ownership in
// meta); this table is just the player's album membership list,
// so every picker (New post, New clip, Add to story) can show
// their WHOLE album — posts, clips, stories and these additions.
export const albumMedia = sqliteTable("album_media", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerKey: text("player_key").notNull(),
  mediaUrl: text("media_url").notNull(),
  mediaType: text("media_type", { enum: ["image", "video"] }).notNull(),
  createdAt: ts("created_at"),
});

export const feedReports = sqliteTable("feed_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id").notNull(),
  reporterKey: text("reporter_key").notNull(),
  reason: text("reason").notNull().default(""),
  createdAt: ts("created_at"),
});

// Player reports (the standard report flow on profiles): any
// signed-in player can report another player — illegal content,
// bad words, bad name, harassment, hate, spam, false information,
// breaking the rules — and the report lands in the owner
// dashboard's moderation queue. One row per reporter per player.
export const playerReports = sqliteTable("player_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reporterKey: text("reporter_key").notNull(),
  reportedKey: text("reported_key").notNull(),
  reason: text("reason").notNull().default(""),
  details: text("details").notNull().default(""),
  createdAt: ts("created_at"),
});

// Direct-message reports (migration 0074): private one-to-one DMs
// are never screened or monitored — the ONLY way a private message
// is ever shown to anyone else is when a participant in that
// conversation reports that specific message. One row per reporter
// per message; the reported message (and only it) appears in the
// Owner Dashboard moderation queue so the owner can deal with the
// report. Unreported private messages are never exposed anywhere.
export const dmReports = sqliteTable("dm_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  messageId: integer("message_id").notNull(),
  reporterKey: text("reporter_key").notNull(),
  reason: text("reason").notNull().default(""),
  details: text("details").notNull().default(""),
  createdAt: ts("created_at"),
});

export const feedHidden = sqliteTable("feed_hidden", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id").notNull(),
  playerKey: text("player_key").notNull(),
  createdAt: ts("created_at"),
});

// Feed post preferences from the post menu's Interested /
// Not interested rows (owner's Instagram-style Feed menu, Nov 21
// 2026): one row per player + post. interested = 1 records
// "Interested" (posts of that kind rank higher for this player in
// the Top sort); interested = 0 records "Not interested" and the
// post is also hidden for that player (a feed_hidden row).
export const feedPreferences = sqliteTable("feed_preferences", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id").notNull(),
  playerKey: text("player_key").notNull(),
  interested: integer("interested").notNull().default(1),
  createdAt: ts("created_at"),
});

// ---- Vice Credits, Rank Points and seasons ----
// Rank Points come only from actions that happen inside ViceSunshine
// itself (RSVPs, posts, LFG teams, joins, moderator confirmations in the
// trackers) — counted automatically, because the app can see its own
// activity. Nothing here claims to verify gameplay inside GTA VI.

export const creditTransactions = sqliteTable("credit_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // "personal" wallet of a player, or "clan" wallet of a clan.
  scope: text("scope", { enum: ["personal", "clan"] }).notNull().default("personal"),
  // playerKey for personal, clan id (as text) for clan.
  ownerId: text("owner_id").notNull(),
  actorKey: text("actor_key").notNull().default(""),
  amount: integer("amount").notNull().default(0),
  reason: text("reason").notNull().default(""),
  createdAt: ts("created_at"),
});

export const rankPointEvents = sqliteTable("rank_point_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // 0 means the player had no clan — the points still count personally.
  clanId: integer("clan_id").notNull().default(0),
  playerKey: text("player_key").notNull(),
  gamertag: text("gamertag").notNull().default(""),
  points: integer("points").notNull().default(0),
  source: text("source").notNull().default(""),
  // Unique per player+activity (e.g. "mission:12") so one activity can
  // only ever be confirmed once per player.
  sourceRef: text("source_ref").notNull().default(""),
  reason: text("reason").notNull().default(""),
  seasonKey: text("season_key").notNull().default(""),
  verifiedBy: text("verified_by").notNull().default(""),
  createdAt: ts("created_at"),
});

export const clanWars = sqliteTable("clan_wars", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  weekKey: text("week_key").notNull(),
  challenge: text("challenge").notNull().default(""),
  challengeAction: text("challenge_action").notNull().default(""),
  endsAt: text("ends_at").notNull().default(""),
  status: text("status", { enum: ["Active", "Closed"] }).notNull().default("Active"),
  winnerClanId: integer("winner_clan_id"),
  createdAt: ts("created_at"),
});

export const clanWarEntries = sqliteTable("clan_war_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  warId: integer("war_id").notNull(),
  clanId: integer("clan_id").notNull(),
  createdAt: ts("created_at"),
});

export const warActivity = sqliteTable("war_activity", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  warId: integer("war_id").notNull(),
  clanId: integer("clan_id").notNull(),
  playerKey: text("player_key").notNull(),
  action: text("action").notNull().default(""),
  points: integer("points").notNull().default(0),
  sourceRef: text("source_ref").notNull().default(""),
  createdAt: ts("created_at"),
});

export const activityReports = sqliteTable("activity_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: integer("event_id").notNull(),
  reporterKey: text("reporter_key").notNull(),
  reason: text("reason").notNull().default(""),
  createdAt: ts("created_at"),
});

export const ownedItems = sqliteTable("owned_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerType: text("owner_type", { enum: ["clan", "personal"] }).notNull().default("personal"),
  // clan id (as text) or playerKey.
  ownerId: text("owner_id").notNull(),
  itemId: text("item_id").notNull(),
  equipped: integer("equipped").notNull().default(0),
  createdAt: ts("created_at"),
});

export const seasonWinners = sqliteTable("season_winners", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  seasonKey: text("season_key").notNull(),
  board: text("board").notNull().default("Global"),
  clanId: integer("clan_id").notNull(),
  clanName: text("clan_name").notNull().default(""),
  rank: integer("rank").notNull().default(0),
  seasonPoints: integer("season_points").notNull().default(0),
  creditsAwarded: integer("credits_awarded").notNull().default(0),
  emblemAwarded: text("emblem_awarded").notNull().default(""),
  createdAt: ts("created_at"),
});

export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
});

// Automatic self-correction log (migration 0070): every fix the
// correction pass applies when new official / well-sourced GTA VI
// reporting proves something ViceSunshine already had stored was
// wrong — a Database entry, a news story, a team guide or a map
// label name. One row per corrected field, with the before/after
// values and the source that proved the change, so every
// automatic fix stays auditable. Written only by
// runCorrectionPass in actions.ts; nothing else inserts here.
export const contentCorrections = sqliteTable("content_corrections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  targetType: text("target_type").notNull().default(""),
  targetLabel: text("target_label").notNull().default(""),
  field: text("field").notNull().default(""),
  oldValue: text("old_value").notNull().default(""),
  newValue: text("new_value").notNull().default(""),
  sourceName: text("source_name").notNull().default(""),
  sourceUrl: text("source_url").notNull().default(""),
  createdAt: ts("created_at"),
});

export const dbEntries = sqliteTable("db_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["Vehicle", "Weapon", "Character", "Location"] })
    .notNull()
    .default("Vehicle"),
  name: text("name").notNull(),
  category: text("category").notNull().default(""),
  description: text("description").notNull().default(""),
  status: text("status", {
    enum: ["Confirmed in trailer", "Reported", "Unverified", "Returning from GTA V"],
  })
    .notNull()
    .default("Unverified"),
  sourceName: text("source_name").notNull().default(""),
  sourceUrl: text("source_url").notNull().default(""),
  featured: integer("featured").notNull().default(0),
  type: text("type").notNull().default(""),
  manufacturer: text("manufacturer").notNull().default(""),
  // Drivetrain for vehicle filtering (FWD / RWD / AWD) — set from the
  // team's catalog for road vehicles whose layout is known from
  // GTA V; empty for boats, aircraft, bicycles and unknown layouts.
  drivetrain: text("drivetrain").notNull().default(""),
  // 1 when the entry was added by the automatic web-research sync
  // (refreshDbEntries) rather than the team's managed catalog.
  // The catalog reconcile in seedExamples never deletes or
  // overwrites auto-discovered rows — they are the Database
  // growing on its own when something new appears.
  autoDiscovered: integer("auto_discovered").notNull().default(0),
  imageBlobKey: text("image_blob_key").notNull().default(""),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export const dbRatings = sqliteTable("db_ratings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entryId: integer("entry_id").notNull(),
  playerKey: text("player_key").notNull(),
  rating: integer("rating").notNull().default(5),
  createdAt: ts("created_at"),
});

// ---- Voice chat (ViceSunshine community voice, NOT Rockstar / GTA VI voice) ----
// Presence-based voice channels: clan channels (General / Clan War /
// Car Meet / LFG), one lobby channel per community event, one team
// channel per LFG post. A participant row is live only while its
// last_seen heartbeat is fresh (clients heartbeat every few seconds);
// stale rows are pruned server-side on read. WebRTC peer audio is
// negotiated peer-to-peer using voice_signals as the signalling mailbox
// — calls are never recorded and no audio ever touches the server.

export const voiceParticipants = sqliteTable("voice_participants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // "clan" | "event" | "lfg"
  scope: text("scope").notNull().default("clan"),
  scopeId: integer("scope_id").notNull().default(0),
  channelKey: text("channel_key").notNull().default("general"),
  playerKey: text("player_key").notNull(),
  gamertag: text("gamertag").notNull().default(""),
  muted: integer("muted").notNull().default(0),
  deafened: integer("deafened").notNull().default(0),
  speaking: integer("speaking").notNull().default(0),
  // Set by a Leader / Co-Leader / host: the member cannot unmute while 1.
  forceMuted: integer("force_muted").notNull().default(0),
  // Set by a moderator: the member cannot hear the call (or un-deafen)
  // while 1.
  forceDeafened: integer("force_deafened").notNull().default(0),
  // Epoch ms of the last heartbeat (plain integer for cheap freshness maths).
  lastSeen: integer("last_seen").notNull().default(0),
  createdAt: ts("created_at"),
});

export const voiceSignals = sqliteTable("voice_signals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fromKey: text("from_key").notNull(),
  toKey: text("to_key").notNull(),
  // "offer" | "answer" | "ice" | "bye"
  kind: text("kind").notNull().default("offer"),
  payload: text("payload").notNull().default(""),
  createdAt: ts("created_at"),
});

export const voiceReports = sqliteTable("voice_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scope: text("scope").notNull().default("clan"),
  scopeId: integer("scope_id").notNull().default(0),
  reporterKey: text("reporter_key").notNull(),
  targetKey: text("target_key").notNull().default(""),
  targetGamertag: text("target_gamertag").notNull().default(""),
  reason: text("reason").notNull().default(""),
  createdAt: ts("created_at"),
});

// Who actually took a spot in an LFG team (joinLfg used to only count
// spots). Team voice access is checked against this table + the author.
export const lfgMembers = sqliteTable("lfg_members", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lfgId: integer("lfg_id").notNull(),
  playerKey: text("player_key").notNull(),
  gamertag: text("gamertag").notNull().default(""),
  createdAt: ts("created_at"),
});

// In-app notifications (e.g. "X reposted your post"). The recipient is
// the original poster; rows are created by the action that caused them.
export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerKey: text("player_key").notNull(),
  actorGamertag: text("actor_gamertag").notNull().default(""),
  kind: text("kind").notNull().default("Repost"),
  postId: integer("post_id").notNull().default(0),
  repostPostId: integer("repost_post_id").notNull().default(0),
  postTitle: text("post_title").notNull().default(""),
  read: integer("read").notNull().default(0),
  createdAt: ts("created_at"),
});

// ---- Clan channels (Leader-structured, Discord-style layout) ----
// Each clan's text and voice channels are rows, not fixed constants, so
// a Leader / Co-Leader (or an Elder, when the Leader allows it) can
// create, rename, reorder and delete them. A channel is Public (every
// clan member can see and join it) or Private (only members whose role
// is in allowed_roles, or whose playerKey is in allowed_keys, plus the
// Leader / Co-Leaders, can see it at all). Voice channels can carry a
// member limit (0 = no limit). The default channels every clan starts
// with are materialised lazily by the server (see clanChannelsOf).
export const clanChannels = sqliteTable("clan_channels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clanId: integer("clan_id").notNull(),
  kind: text("kind", { enum: ["text", "voice"] }).notNull().default("voice"),
  key: text("key").notNull(),
  name: text("name").notNull(),
  visibility: text("visibility", { enum: ["public", "private"] })
    .notNull()
    .default("public"),
  // Comma-separated role names / playerKeys allowed into a private
  // channel. Empty = only Leader / Co-Leader (who always can).
  allowedRoles: text("allowed_roles").notNull().default(""),
  allowedKeys: text("allowed_keys").notNull().default(""),
  memberLimit: integer("member_limit").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: ts("created_at"),
});

// ---- Party Calls ----
// A Party Call is a named voice room (max 20 people) anyone can
// create; the creator is the host and controls it (mute / remove /
// end call / Public or Private / invite). Anyone with the invite code
// (or the invite link carrying it) who is a ViceSunshine member can join,
// clan or no clan. A 2-person Party Call is how two friends talk
// one-on-one — there is no separate 1-on-1 call type. Membership rows
// record who has joined the party; the live call itself is
// voice_participants with scope "party". Public parties are listed on
// the Calls page for any member to join; Private parties are only
// visible to people already in them. When the host ends the call,
// ended = 1, everyone is removed, and nobody can join again.
export const partyCalls = sqliteTable("party_calls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  hostKey: text("host_key").notNull(),
  hostGamertag: text("host_gamertag").notNull().default(""),
  inviteCode: text("invite_code").notNull(),
  maxMembers: integer("max_members").notNull().default(20),
  visibility: text("visibility", { enum: ["public", "private"] })
    .notNull()
    .default("public"),
  ended: integer("ended").notNull().default(0),
  createdAt: ts("created_at"),
});

export const partyMembers = sqliteTable("party_members", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  partyId: integer("party_id").notNull(),
  playerKey: text("player_key").notNull(),
  gamertag: text("gamertag").notNull().default(""),
  role: text("role", { enum: ["Host", "Member"] }).notNull().default("Member"),
  createdAt: ts("created_at"),
});

// ---- Saved payment methods (Settings > Wallet) ----
// What Stripe returns after its own secure card form collects the
// card: brand, last 4 digits, expiry and a display label ONLY.
// ViceSunshine never receives, sees or stores a full card number, a
// CVC, or any bank account details — those live with Stripe. A row
// here is the reference the one-tap checkout buttons use ("Pay with
// Visa •••• 4242"); the charge itself only ever happens inside
// Stripe checkout once payments are connected.
export const paymentMethods = sqliteTable("payment_methods", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerKey: text("player_key").notNull(),
  brand: text("brand", {
    enum: ["Visa", "Mastercard", "Amex", "Discover", "Interac", "Other card"],
  })
    .notNull()
    .default("Visa"),
  // Exactly 4 digits — the last four of the card, as Stripe reports
  // them. There is deliberately no column that could hold more.
  last4: text("last4").notNull().default(""),
  expMonth: integer("exp_month").notNull().default(1),
  expYear: integer("exp_year").notNull().default(2030),
  label: text("label").notNull().default(""),
  isDefault: integer("is_default").notNull().default(0),
  createdAt: ts("created_at"),
});

// ---- Stripe Premium payments (migration 0093) ----
// One row per Stripe subscription a sync has VERIFIED in the
// owner's live Stripe account (product prod_Vg7UFc35Fy0oOi,
// "ViceSunshine Premium"). Rows are written only by
// recordStripePremiumPayment, which is called by the Stripe sync
// tasks after they read the subscription from Stripe itself —
// never from a client claim that a payment happened. The row is
// the site's durable link between a player and their real
// subscription: it drives the wallet payment history, the Owner
// Dashboard revenue total (totalPaidCents is the lifetime amount
// Stripe reports as actually paid on the subscription, in the
// smallest unit of `currency`), and the Stripe-side cancel /
// resume tasks. No card or bank detail ever appears here — only
// Stripe's own object ids.
export const stripePayments = sqliteTable("stripe_payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerKey: text("player_key").notNull().default(""),
  // The email the Stripe customer / checkout used — the match key
  // between a Stripe payment and a ViceSunshine account (the
  // player's contact email on their profile).
  email: text("email").notNull().default(""),
  stripeCustomerId: text("stripe_customer_id").notNull().default(""),
  stripeSubscriptionId: text("stripe_subscription_id").notNull().default(""),
  stripeSessionId: text("stripe_session_id").notNull().default(""),
  // ISO currency code of the price paid (USD / CAD / GBP / EUR /
  // AUD — the five live Stripe prices).
  currency: text("currency").notNull().default("USD"),
  // The subscription's monthly amount, smallest currency unit.
  amountCents: integer("amount_cents").notNull().default(0),
  // Lifetime amount Stripe reports as paid on this subscription,
  // smallest currency unit — the honest revenue figure.
  totalPaidCents: integer("total_paid_cents").notNull().default(0),
  // Stripe's own subscription status: active / trialing /
  // past_due / canceled / unpaid / incomplete / paused.
  status: text("status").notNull().default("active"),
  cancelAtPeriodEnd: integer("cancel_at_period_end").notNull().default(0),
  // Current paid period as ISO dates (YYYY-MM-DD), from Stripe.
  periodStart: text("period_start").notNull().default(""),
  periodEnd: text("period_end").notNull().default(""),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

// Players who have joined the ViceSunshine Discord server. A row here
// means the Discord card on the Community Feed never shows for that
// player again — the card is only for people who have not joined yet.
// Recorded when the player confirms they joined (after tapping Join,
// or via the card's "I've already joined" control). There is no way
// to verify a Discord membership from ViceSunshine, so this is the
// player's own confirmation, stored against their device player key.
export const discordJoins = sqliteTable("discord_joins", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerKey: text("player_key").notNull(),
  createdAt: ts("created_at"),
});

// Instagram-style follows between ViceSunshine accounts: one row =
// follower_key follows following_key. Real and saved per account —
// counts, follower/following lists and Follow / Follow back states
// are all derived from these rows. Both keys must belong to real
// profiles (enforced in setFollow); following only works signed in.
export const profileFollows = sqliteTable("profile_follows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  followerKey: text("follower_key").notNull(),
  followingKey: text("following_key").notNull(),
  createdAt: ts("created_at"),
});

// Follow requests to PRIVATE accounts (migration 0067): one row =
// requester_key has asked to follow following_key and is waiting.
// Following a public account never creates a row here — it follows
// straight away. A private account's owner accepts (the request row
// is deleted and a real profile_follows row is created — one-way:
// the owner does NOT have to follow back for the requester to see
// the profile) or declines (the row is just deleted). The requester
// can also cancel their own pending request (setFollow follow=false).
export const followRequests = sqliteTable("follow_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requesterKey: text("requester_key").notNull(),
  followingKey: text("following_key").notNull(),
  createdAt: ts("created_at"),
});

// Signed follow history: one row per follow (+1) and unfollow (−1),
// written by setFollow at the moment the change happens. The current
// profile_follows rows alone can only ever show growth — an unfollow
// deletes the row — so the Profile insights graph builds its
// Followers / Following lines from these deltas and can go DOWN as
// well as up. Rows are never edited or removed.
export const followEvents = sqliteTable("follow_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  followerKey: text("follower_key").notNull(),
  followingKey: text("following_key").notNull(),
  action: text("action").notNull().default("follow"),
  createdAt: ts("created_at"),
});

// Rockstar service status checks: each row is one real read of
// Rockstar's official service status page (support.rockstargames.com/
// servicestatus) by refreshRockstarStatus — the overall state plus
// the per-service lines exactly as read. The Home status block and
// the Service Status page show the latest check and when it ran;
// nothing is shown as "online" without a check behind it.
export const rockstarStatusChecks = sqliteTable("rockstar_status_checks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  overall: text("overall").notNull().default("unknown"),
  servicesJson: text("services_json").notNull().default("[]"),
  sourceUrl: text("source_url").notNull().default(""),
  createdAt: ts("created_at"),
});

// Instagram-style direct messages between ViceSunshine accounts.
// One row = one message; a conversation is the pair of player keys.
// `seen` flips when the recipient opens the thread. Pins are per
// player (my pinned chats sit on top of my list only).
export const directMessages = sqliteTable("direct_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  senderKey: text("sender_key").notNull(),
  recipientKey: text("recipient_key").notNull(),
  body: text("body").notNull().default(""),
  seen: integer("seen").notNull().default(0),
  // 0 = a one-to-one DM (sender_key / recipient_key). >0 = a
  // message inside the chat_groups row with that id (recipient_key
  // is "" there; read state is per member on chat_group_members).
  groupId: integer("group_id").notNull().default(0),
  // Crew join-request cards (migration 0081): >0 on a system
  // message inside a crew chat means this message IS the card for
  // that clan_applications row (kind "join_request") — the crew
  // chat renders it with Accept / Decline for the Leader, and its
  // state is read live from the application row, so an answered
  // card shows Accepted / Declined forever after.
  joinRequestId: integer("join_request_id").notNull().default(0),
  // Event announcement cards (migration 0084): >0 on a system
  // message inside a CREW chat means this message IS the card
  // announcing that Community Event to the hosting crew — posted
  // by createEvent the moment the crew's Leader creates the
  // event. The crew chat renders it with Participate / Not
  // participate: Participate RSVPs the tapper Going (which puts
  // them in the event's own group chat, exactly like a crew
  // chat), and Not participate records an event_card_dismissals
  // row so the card disappears for that player alone.
  eventCardId: integer("event_card_id").notNull().default(0),
  // Event join-request cards (migration 0092): >0 on a system
  // message inside an EVENT chat means this message IS the card
  // for that event_join_requests row — posted by rsvpEvent the
  // moment a player from outside the host crew asks to join a
  // Request-mode event. The event chat renders it with Confirm /
  // Decline for the event's manager (the host or the hosting
  // crew's Leader), and its state is read live from the ask row,
  // exactly like the crew chat's join-request cards above.
  eventJoinRequestId: integer("event_join_request_id").notNull().default(0),
  // Crew invite cards (migration 0086): >0 on a one-to-one DM
  // means this message IS a crew invite card for that clan — sent
  // from a crew's Share sheet (sendCrewInviteDm). The DM thread
  // renders it as a welcoming box carrying the crew's banner and
  // emblem: Accept / Decline when the crew is public, or a
  // "tell the Leader why you want in" text bar + Request button
  // when the crew is private or request-only. crewInviteState
  // records the recipient's Decline ("declined"); whether they
  // joined, or have a request waiting, is read live from the
  // crew's own rows, never stored here.
  crewInviteId: integer("crew_invite_id").notNull().default(0),
  crewInviteState: text("crew_invite_state").notNull().default(""),
  // Event invite cards: >0 on a one-to-one DM means this
  // message IS an event invite card for that event — sent from
  // an event's Share sheet ("Send it in Messages",
  // sendEventInviteDm). The DM thread renders it with the same
  // welcoming invite-box design as a crew invite: the event's
  // picture as the banner, its title, host and start time, and
  // the reader's answer on the card (Join RSVPs them Going
  // through rsvpEvent). Whether they joined is read live from
  // the event's own RSVP rows, never stored here.
  eventInviteId: integer("event_invite_id").notNull().default(0),
  createdAt: ts("created_at"),
});

// Group chats and crew chats (migration 0055). kind "group" is a
// player-made group chat (the creator adds anyone they follow);
// kind "crew" is a crew's automatic chat — created for every crew,
// membership always mirrors clan_members, and the crew Leader is
// the owner. Messages for both live in direct_messages (group_id).
export const chatGroups = sqliteTable("chat_groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["group", "crew", "event"] }).notNull().default("group"),
  name: text("name").notNull().default(""),
  clanId: integer("clan_id"),
  // For kind = "event" (migration 0057): the Community Event this
  // chat belongs to. Membership mirrors the event's Going list plus
  // its host, and the host (the hosting crew's Leader) owns it.
  eventId: integer("event_id").notNull().default(0),
  ownerKey: text("owner_key").notNull().default(""),
  createdAt: ts("created_at"),
});

export const chatGroupMembers = sqliteTable("chat_group_members", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  groupId: integer("group_id").notNull(),
  playerKey: text("player_key").notNull(),
  lastReadId: integer("last_read_id").notNull().default(0),
  // Chat mute (migration 0057): 1 when the chat's leader (event
  // host / crew Leader / group owner) has muted this member — they
  // can read but cannot send until unmuted.
  muted: integer("muted").notNull().default(0),
  createdAt: ts("created_at"),
});

export const dmPins = sqliteTable("dm_pins", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerKey: text("player_key").notNull(),
  otherKey: text("other_key").notNull(),
  createdAt: ts("created_at"),
});

// Real search counts for the global search overlay: one row per
// normalised search term, incremented every time a player actually
// submits that search (Enter, a trending tap, or opening the full
// results). The "Most searched" list is derived ONLY from these rows
// — counts are never invented. Curated suggestions fill the list
// until real searches exist, and they carry no count.
export const searchTerms = sqliteTable("search_terms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  termKey: text("term_key").notNull(),
  term: text("term").notNull().default(""),
  count: integer("count").notNull().default(0),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

// Client crash reports (migration 0077): when the app hits the
// "hit a snag" error screen on a player's device, the error boundary
// records what actually crashed here — the error message, stack and
// React component stack, plus which screen was open — instead of
// swallowing it. The Owner reads these back (getClientErrors) to
// find and fix the real cause. Reports are diagnostics only: no post
// content, no messages, nothing the player typed beyond the screen
// name they were on.
export const clientErrors = sqliteTable("client_errors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerKey: text("player_key").notNull().default(""),
  message: text("message").notNull().default(""),
  stack: text("stack").notNull().default(""),
  componentStack: text("component_stack").notNull().default(""),
  screen: text("screen").notNull().default(""),
  userAgent: text("user_agent").notNull().default(""),
  createdAt: ts("created_at"),
});

export const supportRequests = sqliteTable("support_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerKey: text("player_key").notNull().default(""),
  gamertag: text("gamertag").notNull().default(""),
  topic: text("topic").notNull().default("Other"),
  details: text("details").notNull().default(""),
  status: text("status").notNull().default("Open"),
  createdAt: ts("created_at"),
});

// Discord Premium role sync state (migration 0073): one row per
// player who has ever been in scope for the Premium Discord role.
// This is the bot-ready handoff for the "Premium" role in the
// official ViceSunshine Discord server (which unlocks the private
// Premium lounge). The SITE owns `desired` — recomputed from the
// player's real Premium state and linked Discord name whenever the
// profile / wallet is read, on sign-in, and when the owner opens
// the dashboard: "grant" = Premium active AND Discord linked,
// "remove" = anything else. The BOT owns `botStatus` — it only
// moves when the bot itself confirms through ackDiscordRoleSync
// that it applied (or failed to apply) the change, so the site
// never claims a role was granted before a bot confirmed it.
// Until a bot exists, the Owner Dashboard renders these rows as
// the manual grant/remove list for the owner. A row whose desired
// state the bot has not confirmed yet reads botStatus "pending";
// "failed" keeps the desired state and stores the bot's note so
// the next sync retries it.
export const discordRoleSync = sqliteTable("discord_role_sync", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerKey: text("player_key").notNull(),
  // Snapshot of the linked Discord username the role applies to.
  discordId: text("discord_id").notNull().default(""),
  desired: text("desired", { enum: ["grant", "remove"] })
    .notNull()
    .default("remove"),
  botStatus: text("bot_status", {
    enum: ["pending", "granted", "removed", "failed"],
  })
    .notNull()
    .default("pending"),
  botNote: text("bot_note").notNull().default(""),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

// UI translation cache (Settings → Languages): one row per
// language, holding the JSON map of ViceSunshine's interface
// strings translated into that language. Filled once per
// language by getUiTranslations (model translation), then read
// by every device that picks the language — so a language is
// only ever translated a single time.
export const uiTranslations = sqliteTable("ui_translations", {
  language: text("language").primaryKey(),
  data: text("data").notNull().default("{}"),
  updatedAt: ts("updated_at"),
});
