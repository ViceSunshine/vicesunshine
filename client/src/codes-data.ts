// ─────────────────────────────────────────────────────────────────────────────
// GTA 6 CODES & UNLOCKS — the ONE list behind the Codes tab in Guides.
//
// HOW TO UPDATE A CODE (no page redesign needed):
//   • A code that is not out yet has  code: null  → the page shows
//     "Code not yet known" in grey, with no code buttons.
//   • When that code is found and verified in-game, set its `code`
//     to the D-pad sequence, e.g. code: ["UP", "RIGHT", "DOWN"] —
//     the page then shows it automatically as Verified, in both the
//     Text and Symbols display modes. Nothing else needs to change.
//
// Codes are D-pad directions ONLY (UP / DOWN / LEFT / RIGHT) and are
// identical on PlayStation 5 and Xbox Series X|S — only the shoulder
// buttons used to open the code entry differ (L1/R1 vs LB/RB).
//
// Counts: PLAYER 10 · COMBAT 11 · VEHICLES 21 · ENVIRONMENT 3 ·
// SCREEN FILTERS 16 = 61 codes. 17 are known; 44 are not out yet.
// Every code also has its own unlock requirement — finishing the
// story comes first, then the requirement listed on its row.
// ─────────────────────────────────────────────────────────────────────────────

export type CodeDir = "UP" | "DOWN" | "LEFT" | "RIGHT";

export type CodeCategoryId = "PLAYER" | "COMBAT" | "VEHICLES" | "ENVIRONMENT" | "SCREEN FILTERS";

export interface Gta6Code {
  name: string;
  category: CodeCategoryId;
  description: string;
  unlock: string;
  /** D-pad sequence, or null while the code is not yet known. */
  code: CodeDir[] | null;
}

export const CODE_CATEGORIES: { id: CodeCategoryId; label: string }[] = [
  { id: "PLAYER", label: "Player" },
  { id: "COMBAT", label: "Combat" },
  { id: "VEHICLES", label: "Vehicles" },
  { id: "ENVIRONMENT", label: "Environment" },
  { id: "SCREEN FILTERS", label: "Screen Filters" },
];

export const GTA6_CODES: Gta6Code[] = [
  // ── PLAYER (10) ────────────────────────────────────────────────────────────
  { name: "$250,000", category: "PLAYER", description: "Adds $250,000 to your cash", unlock: "Finish the story", code: ["UP", "RIGHT", "DOWN", "LEFT", "UP", "LEFT", "DOWN", "RIGHT"] },
  { name: "Drunk", category: "PLAYER", description: "Makes you and your partner drunk", unlock: "Spend $2,500 on alcohol", code: null },
  { name: "Raise Heat Level", category: "PLAYER", description: "Raises your heat across the map", unlock: "Lose a 3-star wanted level 25 times", code: ["LEFT", "DOWN", "RIGHT", "DOWN", "UP", "DOWN", "UP"] },
  { name: "Raise Wanted Level", category: "PLAYER", description: "Raises your wanted level across the map", unlock: "Lose a 3-star wanted level 50 times", code: null },
  { name: "Unlimited Focus", category: "PLAYER", description: "Focus never runs out", unlock: "Finish the story", code: ["DOWN", "UP", "UP", "DOWN", "UP", "DOWN", "UP", "DOWN", "UP", "RIGHT"] },
  { name: "No Fall Damage", category: "PLAYER", description: "Immunity to fall damage", unlock: "Survive a 40-foot freefall 20 times", code: null },
  { name: "Parachute", category: "PLAYER", description: "Adds a parachute to your loadout", unlock: "Complete 50 skydives or BASE jumps from 300+ feet", code: null },
  { name: "Body Armor", category: "PLAYER", description: "Adds body armor to your loadout", unlock: "Complete 100 workouts", code: ["DOWN", "UP", "LEFT", "UP", "UP", "UP", "UP", "UP", "DOWN", "DOWN"] },
  { name: "Repair Vehicle", category: "PLAYER", description: "Fully repairs your current vehicle", unlock: "Win 1st place in 10 races at Gellhorn Raceway, Thrillbilly Mud Club, and Boone Speedway", code: null },
  { name: "Unlimited Nitrous", category: "PLAYER", description: "Nitrous and fuel never run out", unlock: "Complete 50 stunt jumps", code: null },

  // ── COMBAT (11) ────────────────────────────────────────────────────────────
  { name: "Max Ammo", category: "COMBAT", description: "Fills all ammo to maximum", unlock: "Win 25 bronze medals or higher at shooting ranges", code: ["DOWN", "UP", "RIGHT", "DOWN", "LEFT", "LEFT", "UP", "UP", "DOWN", "LEFT"] },
  { name: "Infinite Ammo", category: "COMBAT", description: "Ammo never runs out", unlock: "Win 25 silver medals or higher at shooting ranges", code: ["DOWN", "UP", "RIGHT", "DOWN", "LEFT", "LEFT", "UP", "DOWN", "DOWN", "DOWN"] },
  { name: "No Reload", category: "COMBAT", description: "Ammo never runs out and you never reload", unlock: "Win 25 gold medals at shooting ranges", code: ["DOWN", "UP", "RIGHT", "DOWN", "LEFT", "LEFT", "UP", "DOWN", "DOWN", "UP"] },
  { name: "All Explosive Weapons", category: "COMBAT", description: "Adds all explosive weapons with full ammo", unlock: "Throw 100 grenades", code: null },
  { name: "Incendiary Ammo", category: "COMBAT", description: "All ammo is incendiary", unlock: "Burn 100 enemies with fire damage", code: null },
  { name: "Exploding Bottles", category: "COMBAT", description: "Bottles explode when damaged", unlock: "Throw 100 molotovs", code: null },
  { name: "Explosive Shotgun", category: "COMBAT", description: "Adds a Mason & Keen Shortstraw that fires explosive shells", unlock: "Hit 100 enemies with explosive damage", code: null },
  { name: "Hauners H-AT", category: "COMBAT", description: "Adds a Hauners H-AT to your loadout", unlock: "Blow up 100 vehicles", code: null },
  { name: "Attack Force", category: "COMBAT", description: "Bullets and melee attacks launch targets on impact", unlock: "Finish the story", code: ["DOWN", "UP", "LEFT", "LEFT", "RIGHT", "DOWN", "DOWN", "UP", "DOWN"] },
  { name: "Exploding Balls", category: "COMBAT", description: "Sports balls explode on impact", unlock: "Hit 20 enemies with explosive damage", code: ["DOWN", "UP", "LEFT", "LEFT", "RIGHT", "DOWN", "DOWN", "UP", "RIGHT"] },
  { name: "Vehicle Force", category: "COMBAT", description: "Vehicle collisions launch targets", unlock: "Kill 25 enemies with a vehicle (civilians count)", code: ["DOWN", "UP", "LEFT", "LEFT", "RIGHT", "DOWN", "LEFT", "UP", "DOWN"] },

  // ── VEHICLES (21) ──────────────────────────────────────────────────────────
  { name: "Speeder 700 GT", category: "VEHICLES", description: "Spawns a Speeder 700 GT", unlock: "Complete 5 combat challenges", code: null },
  { name: "Bravado Banshee", category: "VEHICLES", description: "Spawns a Bravado Banshee", unlock: "Complete all combat challenges", code: null },
  { name: "Maibatsu Sanchez", category: "VEHICLES", description: "Spawns a Maibatsu Sanchez", unlock: "Complete 5 criminal challenges", code: null },
  { name: "Western Zombie Bobber", category: "VEHICLES", description: "Spawns a Western Zombie Bobber", unlock: "Complete all criminal challenges", code: null },
  { name: "Nagasaki Sea Sparrow", category: "VEHICLES", description: "Spawns a Nagasaki Sea Sparrow", unlock: "Complete 5 exploration challenges", code: null },
  { name: "Nagasaki Carbon RS", category: "VEHICLES", description: "Spawns a Nagasaki Carbon RS", unlock: "Complete all exploration challenges", code: null },
  { name: "Tuff BMX", category: "VEHICLES", description: "Spawns a Tuff BMX", unlock: "Complete 5 fitness challenges", code: null },
  { name: "'65 Vapid Dominator", category: "VEHICLES", description: "Spawns a '65 Vapid Dominator", unlock: "Complete all fitness challenges", code: null },
  { name: "Maibatsu Boomazoom", category: "VEHICLES", description: "Spawns a Maibatsu Boomazoom", unlock: "Complete 5 shopping challenges", code: ["LEFT", "UP", "RIGHT", "DOWN", "LEFT", "LEFT", "UP", "LEFT"] },
  { name: "Truffade Thrax", category: "VEHICLES", description: "Spawns a Truffade Thrax", unlock: "Complete all shopping challenges", code: null },
  { name: "Vapid Stanier G2 Taxi", category: "VEHICLES", description: "Spawns a Vapid Stanier G2 Taxi", unlock: "Complete 5 sports challenges", code: null },
  { name: "Brimstone Golfer", category: "VEHICLES", description: "Spawns a Brimstone Golfer", unlock: "Complete all sports challenges", code: null },
  { name: "Airboat 09", category: "VEHICLES", description: "Spawns an Airboat 09", unlock: "Complete 5 survival challenges", code: null },
  { name: "Hauners Rhino Tank", category: "VEHICLES", description: "Spawns a Hauners Rhino Tank", unlock: "Complete all survival challenges", code: null },
  { name: "Lapwing Mallard", category: "VEHICLES", description: "Spawns a Lapwing Mallard", unlock: "Complete 5 vehicle challenges", code: null },
  { name: "Progen Emerus", category: "VEHICLES", description: "Spawns a Progen Emerus", unlock: "Complete all vehicle challenges", code: null },
  { name: "Hauners P-996 Lazer", category: "VEHICLES", description: "Spawns a Hauners P-996 Lazer", unlock: "Complete all challenges", code: null },
  { name: "Interstate Ambulance", category: "VEHICLES", description: "Spawns an Interstate Ambulance", unlock: "Discover it in the Progress menu", code: null },
  { name: "MTL Pumper", category: "VEHICLES", description: "Spawns an MTL Pumper", unlock: "Discover it in the Progress menu", code: ["LEFT", "UP", "RIGHT", "DOWN", "LEFT", "RIGHT", "RIGHT", "UP"] },
  { name: "HVY Bulldozer", category: "VEHICLES", description: "Spawns an HVY Bulldozer", unlock: "Discover it in the Progress menu", code: ["LEFT", "UP", "RIGHT", "DOWN", "LEFT", "RIGHT", "RIGHT", "DOWN"] },
  { name: "Inflatable Flamingo", category: "VEHICLES", description: "Spawns an Inflatable Flamingo", unlock: "Destroy 50 cocaine flamingos", code: null },

  // ── ENVIRONMENT (3) ────────────────────────────────────────────────────────
  { name: "Move Time Forward", category: "ENVIRONMENT", description: "Moves the time of day forward", unlock: "Find 10 collectible watches", code: null },
  { name: "Pause Time of Day", category: "ENVIRONMENT", description: "Pauses the time of day", unlock: "Find 20 collectible watches", code: null },
  { name: "Cycle Weather", category: "ENVIRONMENT", description: "Cycles through the weather", unlock: "Finish the story", code: ["DOWN", "RIGHT", "UP", "DOWN", "RIGHT", "UP", "RIGHT"] },

  // ── SCREEN FILTERS (16) ────────────────────────────────────────────────────
  { name: "Golden Hour", category: "SCREEN FILTERS", description: "Golden filter with a widescreen aspect ratio", unlock: "Spend 4 hours holding hands", code: null },
  { name: "Powdered Sugar", category: "SCREEN FILTERS", description: "Turns the world white with sparkling highlights", unlock: "Scan all space debris with WAiNK", code: null },
  { name: "Pinhole", category: "SCREEN FILTERS", description: "Pinhole camera filter", unlock: "Clear 25 gang operations with your partner", code: null },
  { name: "Neon Jungle", category: "SCREEN FILTERS", description: "Adds neon highlights to the world", unlock: "Discover all 16 Girlypop Vehicles", code: null },
  { name: "Yesteryear", category: "SCREEN FILTERS", description: "Black-and-white CRT TV filter", unlock: "Discover the Ridgeway", code: null },
  { name: "Cataclysm", category: "SCREEN FILTERS", description: "Murky smoke fills the world", unlock: "Discover Martha's Vamos in the Progress menu", code: ["DOWN", "DOWN", "UP", "RIGHT", "RIGHT", "UP", "LEFT", "LEFT", "RIGHT", "RIGHT"] },
  { name: "Videotape", category: "SCREEN FILTERS", description: "Videotape-style filter", unlock: "Complete 50 activities with your partner", code: null },
  { name: "Dark Mirror", category: "SCREEN FILTERS", description: "Flips the world upside down and turns it black", unlock: "Make $500,000 selling vehicles", code: null },
  { name: "Migraine", category: "SCREEN FILTERS", description: "Blurred, distorted filter", unlock: "Survive 6 minutes with a 6-star wanted level", code: null },
  { name: "Dollhouse", category: "SCREEN FILTERS", description: "Vivid filter with a narrow aspect ratio", unlock: "Spend 8 hours with your partner", code: ["DOWN", "DOWN", "UP", "RIGHT", "RIGHT", "UP", "LEFT", "LEFT", "DOWN", "RIGHT"] },
  { name: "Bubblegum", category: "SCREEN FILTERS", description: "Purple and yellow world with sparkling highlights", unlock: "Find all 24 Vice City Flamingos collectible cards", code: null },
  { name: "Fast Forward", category: "SCREEN FILTERS", description: "Motion blur and faster cloud movement", unlock: "Complete 50 meditations", code: null },
  { name: "Fisheye", category: "SCREEN FILTERS", description: "Fisheye lens filter", unlock: "Catch 100 fish", code: null },
  { name: "Faded Glory", category: "SCREEN FILTERS", description: "Color CRT TV filter", unlock: "Rob 50 stores with your partner", code: ["DOWN", "DOWN", "UP", "RIGHT", "RIGHT", "UP", "LEFT", "LEFT", "LEFT", "RIGHT"] },
  { name: "Pixel Art", category: "SCREEN FILTERS", description: "Pixelated filter", unlock: "Make $250,000 selling collectibles", code: null },
  { name: "Hellscape", category: "SCREEN FILTERS", description: "Red and orange world with heat haze", unlock: "Steal 100 cop vehicles", code: null },
];
