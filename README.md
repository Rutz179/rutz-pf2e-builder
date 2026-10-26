# Rutz's PF2e Character Builder

[Patreon](https://www.patreon.com/Rutz179) · [Discord](https://discord.gg/pnVW5QmXKx) · [Wiki](https://github.com/Rutz179/rutz-pf2e-builder/wiki) · [한국어](README.ko.md)

A guided character creator and level-by-level build planner for **Pathfinder 2e** in Foundry VTT. Build a character with every option explained as you go, plan levels **1–20**, compare builds, and apply the plan when the character levels up.

<img src="media/EN_03.png" alt="Choosing a class, with the Oracle's mystery asked right away" width="860">

## Features
- **Step by step** — ancestry, heritage, background, class, deity, attributes, skills and spells, each with its full description beside the list. Search, rarity and legacy filters; prerequisites marked ✔ / ✖ / ?.
- **Class choices up front** — mysteries, muses, patrons, bloodlines and other "choose one" options are asked while you build, so PF2e doesn't ask again later.
- **Spells** — the class's casting (spellbook, repertoire or whole list) is set up for you; pick spells level by level. Focus spells and class-granted spells are added automatically.
- **Level plans** — feats (free archetype included), skill increases, attribute boosts and spells for every level. Several plans per character (5 by default): continue from the sheet, try a different build from scratch, or copy a plan.
- **Compare** — the current sheet and your plans side by side at any level, calculated by PF2e itself.
- **Level-up** — when a character gains a level, its owner gets a chat card that applies the plan in one click. Applying only adds; nothing already on the sheet is replaced.
- **Familiar Builder** — familiar and master abilities with their prerequisites, and the daily ability count PF2e allows.
- **Homebrew & other modules** — homebrew in compendiums or the world's Items tab is listed with the official options; homebrew spellcasting classes get a spell table; Free Archetype and Gradual Ability Boosts supported; dual-class characters with the free [Dual Class Items](https://foundryvtt.com/packages/pf2e-dual-class-items) module. Nothing else required. [More](https://github.com/Rutz179/rutz-pf2e-builder/wiki/Homebrew-and-Other-Modules)
- **For GMs** — characters per player, starting level, visible rarities, legacy content, which compendiums are read, and more.

<img src="media/EN_06.png" alt="Summary of a character with its main plan, level preview and the New plan dialog" height="320"> <img src="media/EN_07.png" alt="Comparing the current sheet with two plans" height="320">

## Install
Foundry → *Add-on Modules* → *Install Module* → Manifest URL:
```
https://github.com/Rutz179/rutz-pf2e-builder/releases/latest/download/module.json
```
Foundry VTT v13–v14 · Pathfinder 2e system · English / 한국어 (follows Foundry's language)

## Quick start
1. Enable the module in a PF2e world.
2. **Actors** tab → **Create Character** (if you already have a character, the button says **Character Builder** and opens it). On a character sheet, use **Builder** in the header.
3. Work down the left-hand steps. **Still to choose** on the Summary page lists what's missing; then **Create character**.
4. Plan future levels from the **Level plan** list, add other plans with **+**, and check them with **Compare**.
5. On level-up, press **Apply the plan** on the chat card.

Full guide with screenshots: **[Wiki](https://github.com/Rutz179/rutz-pf2e-builder/wiki)**.
Macro: `game.rutzBuilder.open(actor)`.

Questions and bug reports: [Issues](https://github.com/Rutz179/rutz-pf2e-builder/issues) or [Discord](https://discord.gg/pnVW5QmXKx).
