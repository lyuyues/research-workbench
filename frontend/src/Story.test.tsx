import { describe, expect, it } from "vitest";
import { cardText, richText, settle } from "./Story";
import type { Item } from "./Story";

describe("story canvas helpers", () => {
  it("renders the canvas's inline marks and escapes html", () => {
    expect(richText("**D1** *note* `x`\n- item <b>")).toBe(
      "<b>D1</b> <i>note</i> <code>x</code><br><span class=\"sc-li\">• item &lt;b&gt;</span>");
  });
  it("names the section a card sits in", () => {
    const sec: Item = { id: "s", kind: "section", x: 0, y: 0, w: 300, h: 300, text: "Claim 1\nsub" };
    const card: Item = { id: "c", kind: "card", x: 10, y: 10, w: 100, h: 50, text: "Evidence A", color: "support" };
    expect(cardText(card, [sec])).toBe("[support] Evidence A\n(placed in: Claim 1)");
  });
});

describe("settle", () => {
  const h = (it: Item) => it.h ?? 40;
  const sec = (id: string, y: number, hh: number): Item => ({ id, kind: "section", x: 0, y, w: 400, h: hh, text: id });
  const card = (id: string, x: number, y: number): Item => ({ id, kind: "card", x, y, w: 150, h: 60, text: id, color: "plain" });

  it("pushes the card under a dropped card down, and the chain below it", () => {
    const out = settle([card("a", 10, 10), card("b", 20, 40), card("c", 20, 110)], ["a"], h);
    const y = Object.fromEntries(out.map((i) => [i.id, i.y]));
    expect(y.a).toBe(10);
    expect(y.b).toBe(80); // 10 + 60 + 10
    expect(y.c).toBeGreaterThanOrEqual(150);
  });

  it("grows a section to fit its cards and moves the section below with its contents", () => {
    const out = settle([sec("S", 0, 200), sec("T", 220, 100), card("in", 20, 160), card("t1", 20, 240)], ["in"], h);
    const by = Object.fromEntries(out.map((i) => [i.id, i]));
    expect(by.S.h).toBe(160 + 60 + 16);
    expect(by.T.y).toBe(by.S.h! + 10);
    expect(by.t1.y).toBe(240 + (by.T.y! - 220));
  });

  it("leaves a section the user resized alone and untouched items unchanged", () => {
    const items = [sec("S", 0, 100), card("in", 20, 80), card("far", 900, 900)];
    const out = settle(items, ["S"], h);
    expect(out[0]).toBe(items[0]);
    expect(out[2]).toBe(items[2]);
  });

  it("shrinks a section a card left to hug what remains, but keeps empty ones", () => {
    const out = settle([sec("S", 0, 600), card("a", 20, 20), sec("E", 700, 300)], ["a"], h, ["S", "E"]);
    const by = Object.fromEntries(out.map((i) => [i.id, i]));
    expect(by.S.h).toBe(120); // 20 + 60 + 16 = 96 → floor 120
    expect(by.E.h).toBe(300);
  });
});
