import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LIST_LIMIT,
  GRAPHQL_PAGE_SIZE,
  PAGE_DEMAND_THRESHOLD,
  paginationDemand,
  demandedPageCount,
  mergeDemandedPages,
  pageGeneration,
  fetchGraphqlList,
  reconcileSelectionViewport,
} from "../index.mjs";

const node = (number) => ({
  number,
  title: `issue ${number}`,
  url: `https://github.com/acme/widget/issues/${number}`,
  updatedAt: "2026-09-01T00:00:00Z",
  author: { login: "octocat" },
  labels: { nodes: [] },
});

function page(nodes, { hasNextPage, cursor, cost = 2, totalCount = 999 }) {
  return {
    ok: true,
    observedCost: cost,
    overrun: false,
    observations: [],
    data: {
      repository: {
        issues: { totalCount, pageInfo: { hasNextPage, endCursor: cursor }, nodes },
      },
    },
  };
}

function pagedFetcher(pages) {
  const seen = [];
  return {
    seen,
    fetchPage: async (kind, { after = null } = {}) => {
      seen.push(after);
      const index = after === null ? 0 : Number(/^cursor:(\d+)$/.exec(after)[1]);
      return pages[index];
    },
  };
}

const admitAll = async ({ run }) => ({ ok: true, value: await run(undefined) });
const rows = (n, from = 1) => Array.from({ length: n }, (_, i) => node(from + i));

// ---------- PAGE-01 ----------

test("PAGE-01 the first display requires exactly one 50-row page", async () => {
  assert.equal(GRAPHQL_PAGE_SIZE, 50);
  const { fetchPage, seen } = pagedFetcher([
    page(rows(50, 1), { hasNextPage: true, cursor: "cursor:1" }),
    page(rows(50, 51), { hasNextPage: true, cursor: "cursor:2" }),
    page(rows(50, 101), { hasNextPage: false, cursor: null }),
  ]);
  const result = await fetchGraphqlList("issues", (n) => ({ number: n.number }), {
    governor: { scope: {}, leaseId: "lease" },
    fetchPage,
    admit: admitAll,
  });
  // One page, because nothing has demanded more. The walk used to run to 150
  // rows on the very first paint, which is three requests for a pane that shows
  // about twenty.
  assert.deepEqual(seen, [null]);
  assert.equal(result.parse().length, 50);
  // And it says so truthfully: more rows exist.
  assert.equal(result.hasNextPage, true);
  assert.equal(result.incomplete, true);
  assert.equal(result.totalCount, 999);
});

test("PAGE-01 scrolling near the end adds exactly one page", async () => {
  const { fetchPage, seen } = pagedFetcher([
    page(rows(50, 1), { hasNextPage: true, cursor: "cursor:1" }),
    page(rows(50, 51), { hasNextPage: true, cursor: "cursor:2" }),
    page(rows(50, 101), { hasNextPage: false, cursor: null }),
  ]);
  const result = await fetchGraphqlList("issues", (n) => ({ number: n.number }), {
    governor: { scope: {}, leaseId: "lease" },
    fetchPage,
    admit: admitAll,
    pages: 2,
  });
  assert.deepEqual(seen, [null, "cursor:1"]);
  assert.equal(result.parse().length, 100);
  assert.equal(result.hasNextPage, true);
});

test("PAGE-01 demand appears within ten rows of the end and coalesces", () => {
  assert.equal(PAGE_DEMAND_THRESHOLD, 10);
  // 50 loaded rows, cursor at row 39 (index 39) -- still eleven rows of runway.
  assert.equal(paginationDemand({ selectedIndex: 38, loadedRows: 50, hasNextPage: true }), false);
  assert.equal(paginationDemand({ selectedIndex: 40, loadedRows: 50, hasNextPage: true }), true);
  // Nothing more to ask for.
  assert.equal(paginationDemand({ selectedIndex: 49, loadedRows: 50, hasNextPage: false }), false);
  // The cap is a hard stop, not a suggestion.
  assert.equal(paginationDemand({ selectedIndex: 149, loadedRows: LIST_LIMIT, hasNextPage: true }), false);

  // Repeated demand coalesces: pressing j ten times near the end asks for one
  // more page, not ten.
  let demanded = 1;
  for (let i = 0; i < 10; i += 1) {
    demanded = demandedPageCount(demanded, {
      selectedIndex: 45, loadedRows: 50, hasNextPage: true, cap: LIST_LIMIT,
    });
  }
  assert.equal(demanded, 2);
  // Once the extra page arrives, demand at the new end asks for the next one.
  assert.equal(demandedPageCount(2, {
    selectedIndex: 95, loadedRows: 100, hasNextPage: true, cap: LIST_LIMIT,
  }), 3);
  // And never past the cap.
  assert.equal(demandedPageCount(3, {
    selectedIndex: 149, loadedRows: 150, hasNextPage: true, cap: LIST_LIMIT,
  }), 3);
});

test("PAGE-01 no more than 150 rows are ever loaded", async () => {
  const { fetchPage, seen } = pagedFetcher([
    page(rows(50, 1), { hasNextPage: true, cursor: "cursor:1" }),
    page(rows(50, 51), { hasNextPage: true, cursor: "cursor:2" }),
    page(rows(50, 101), { hasNextPage: true, cursor: "cursor:3" }),
    page(rows(50, 151), { hasNextPage: true, cursor: "cursor:4" }),
  ]);
  const result = await fetchGraphqlList("issues", (n) => ({ number: n.number }), {
    governor: { scope: {}, leaseId: "lease" },
    fetchPage,
    admit: admitAll,
    pages: 9,
  });
  assert.equal(seen.length, 3);
  assert.equal(result.parse().length, LIST_LIMIT);
  assert.equal(result.hasNextPage, true);
  assert.equal(result.incomplete, true);
});

test("PAGE-01 a failed next page preserves the rows already held", async () => {
  const { fetchPage } = pagedFetcher([
    page(rows(50, 1), { hasNextPage: true, cursor: "cursor:1" }),
  ]);
  const result = await fetchGraphqlList("issues", (n) => ({ number: n.number }), {
    governor: { scope: {}, leaseId: "lease" },
    fetchPage,
    admit: async () => ({ ok: false, error: new Error("API budget paused") }),
    pages: 2,
  });
  assert.equal(result.parse().length, 50);
  assert.equal(result.incomplete, true);
  assert.equal(result.limit, 50);
});

// ---------- PAGE-02 ----------

test("PAGE-02 pages from incompatible traversals are never joined", () => {
  const first = { generation: "gen-a", rows: rows(3, 1).map((n) => ({ number: n.number })), pageInfo: { hasNextPage: true } };
  const stale = { generation: "gen-a", rows: [{ number: 4 }], pageInfo: { hasNextPage: true } };
  const merged = mergeDemandedPages({ pages: [first, stale] });
  assert.deepEqual(merged.rows.map((r) => r.number), [1, 2, 3, 4]);
  assert.equal(merged.pages, 2);

  // The first page changed underneath an in-flight second page. The old
  // generation is rejected rather than concatenated onto new content.
  const reordered = { generation: "gen-b", rows: [{ number: 9 }, { number: 1 }, { number: 2 }], pageInfo: { hasNextPage: true } };
  const rejected = mergeDemandedPages({ pages: [reordered, stale] });
  assert.deepEqual(rejected.rows.map((r) => r.number), [9, 1, 2]);
  assert.equal(rejected.pages, 1);
  // Still truthful about being incomplete: a page was dropped, not resolved.
  assert.equal(rejected.incomplete, true);
  assert.equal(rejected.hasNextPage, true);
});

test("PAGE-02 duplicates across pages are removed", () => {
  const merged = mergeDemandedPages({
    pages: [
      { generation: "g", rows: [{ number: 1 }, { number: 2 }], pageInfo: { hasNextPage: true } },
      { generation: "g", rows: [{ number: 2 }, { number: 3 }], pageInfo: { hasNextPage: false } },
    ],
  });
  assert.deepEqual(merged.rows.map((r) => r.number), [1, 2, 3]);
  assert.equal(merged.hasNextPage, false);
  assert.equal(merged.incomplete, false);
});

test("PAGE-02 a generation is the identity of the first page's rows", () => {
  assert.equal(pageGeneration([{ number: 1 }, { number: 2 }]), pageGeneration([{ number: 1 }, { number: 2 }]));
  assert.notEqual(pageGeneration([{ number: 1 }, { number: 2 }]), pageGeneration([{ number: 2 }, { number: 1 }]));
  assert.notEqual(pageGeneration([{ number: 1 }]), pageGeneration([{ number: 1 }, { number: 2 }]));
});

test("PAGE-02 selection survives a reorder when its item remains, and is dropped when it does not", () => {
  const after = mergeDemandedPages({
    pages: [{ generation: "g2", rows: [{ number: 9 }, { number: 2 }, { number: 1 }], pageInfo: { hasNextPage: true } }],
  });
  // The item the cursor was on is still present, at a new index. The viewport
  // follows it rather than the index it used to occupy.
  const kept = reconcileSelectionViewport({ items: after.rows, key: 1, offset: 0, rows: 2 });
  assert.equal(kept.key, 1);
  assert.equal(kept.offset, 1);
  // An item that left the list drops the selection instead of silently
  // selecting whatever slid into its place.
  const gone = reconcileSelectionViewport({ items: after.rows, key: 77, offset: 0, rows: 2 });
  assert.equal(gone.key, null);
});

test("PAGE-02 a capped merge still reports more rows exist", () => {
  const merged = mergeDemandedPages({
    pages: [
      { generation: "g", rows: rows(50, 1).map((n) => ({ number: n.number })), pageInfo: { hasNextPage: true } },
      { generation: "g", rows: rows(50, 51).map((n) => ({ number: n.number })), pageInfo: { hasNextPage: true } },
      { generation: "g", rows: rows(50, 101).map((n) => ({ number: n.number })), pageInfo: { hasNextPage: false } },
    ],
    cap: 120,
  });
  assert.equal(merged.rows.length, 120);
  assert.equal(merged.hasNextPage, true);
  assert.equal(merged.incomplete, true);
});
