UPDATE guides SET body = REPLACE(body, 'Read the mission''s page in ViceSunshine Missions first: each mission carries its official source link and, where one exists, a video guide', 'Read the mission''s guide in the Guides section first (the Missions category): each mission guide carries its official source link and, where one exists, a video guide') WHERE body LIKE '%ViceSunshine Missions first%';
--> statement-breakpoint
UPDATE guides SET body = REPLACE(body, 'Tick the mission off in ViceSunshine Missions when you finish it. Your Goals progress and your ViceSunshine level update from what you tick here.', 'When you finish it, move on to the next mission''s guide in Guides — and post your best moment from it to the Feed.') WHERE body LIKE '%Tick the mission off in ViceSunshine Missions%';
--> statement-breakpoint
UPDATE guides SET body = REPLACE(body, 'add tips to the mission''s page instead of spoiling them in the Feed', 'share tips under the mission''s guide instead of spoiling them in the Feed') WHERE body LIKE '%add tips to the mission''s page%';
--> statement-breakpoint
UPDATE guides SET body = REPLACE(body, 'tick missions off in Missions as you finish them', 'follow the mission guides in Guides as you finish them') WHERE body LIKE '%tick missions off in Missions%';
--> statement-breakpoint
UPDATE guides SET body = REPLACE(body, 'in the Missions database — details stay hidden until you tap Show Spoilers', 'in the mission guides (Guides, Missions category) — spoiler-heavy details stay clearly marked') WHERE body LIKE '%in the Missions database%';
