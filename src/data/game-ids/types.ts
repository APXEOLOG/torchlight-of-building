// Numbers the game fills in are "#" in template; args keeps tlidb's own value or range for each.
export interface GameIdText {
  template: string;
  args: string[];
}

export interface GameIdTable {
  skills: Record<string, { name: string }>;
  items: Record<string, { name: string }>;
  legendaries: Record<string, { name: string }>;
  modifiers: Record<string, GameIdText>;
  talents: Record<string, { name: string; tree: string; text: string }>;
  traits: Record<string, { name: string; level: number }>;
  // A memory's base stat has its own ID in the log, which tlidb doesn't list.
  memoryBaseStats: GameIdText[];
}
