# Graph Ladder

English | [日本語](README.md)

A learning tool that lets you stack up a graph pattern with buttons and watch the generated Cypher and its results at the same time. It is meant for session 3 (the graph database session) of [nordwind-workshop](https://github.com/noctetemp/nordwind-workshop).

**[Open the live demo](https://takashiyoshinaga.github.io/Interactive-Search/)**

Your browser talks to your own Neo4j AuraDB directly. There is no server in between.

## What it does

- Reads the schema of whatever you connect to and offers the labels and relationships you can follow next
- Counts, before you click, how many nodes and relationships the next rung would give you
- Turns the ladder you built into runnable Cypher and executes it against your AuraDB
- Highlights only the matching structure, on a 2D or 3D graph whose layout never moves
- Click a node in the graph to narrow the last rung down to that single node
- Switch a relationship between `×1` / `×1..2` / `×1..3` to compare variable-length paths
- Japanese / English, light / dark theme

## Before you start

In the [session 3 Colab notebook](https://colab.research.google.com/github/noctetemp/nordwind-workshop/blob/main/session3_graphs_en.ipynb), run these cells in order. Running "just section 3" is not enough, because the variables that define the dataset would be missing.

1. `%pip -q install neo4j pyvis` in `0 · Setup`
2. The dataset-fetching cell in `0 · Setup`
3. The cell in `3 · 🔌 Connect to your Neo4j` that defines `driver` and `cypher()`
4. The loading cell in the same section, containing `MATCH (n) DETACH DELETE n` and the `UNWIND` / `MERGE` statements

> [!WARNING]
> The loading cell deletes everything already in the database you point it at. Only use it against an Aura instance dedicated to the workshop.

Have the credentials file you downloaded when you created the Aura instance ready as well. On current Aura the username is the instance id rather than `neo4j`. Leave USERNAME blank in Graph Ladder and it will derive it from the BOLT URI for you.

## Using it

1. Open the live demo, confirm the preparation steps, then enter your BOLT URI and PASSWORD.
2. Pick a starting label from "next candidates", then add a relationship and the next label.
3. Compare the Cypher generated along the bottom, the count on each rung, the results on the right and the graph in the middle.
4. Click a node in the graph to pin the last rung to it. Click it again to unpin.
5. Click a relationship row in the ladder to change the hop count, or a rung row to go back to that rung.

What you should see in the workshop:

```text
(:Engineer)                                      30 / 30
-[:RESPONDED_TO]->(:Incident)                    29 / 30 · 20 / 20
-[:AFFECTED]->(:Service)                         29 / 30 · 20 / 20 · 15 / 15
-[:DEPENDS_ON]->(:Service)                       29 / 30 · 19 / 20 · 11 / 15 · 12 / 15
pin the last rung to payment-gateway             10 / 30 ·  6 / 20 ·  1 / 15 ·  1 / 15
change DEPENDS_ON to ×1..2                       18 / 30 · 11 / 20 ·  4 / 15 ·  1 / 15
```

The interesting part is the third line onwards: adding a constraint at the end of the ladder narrows the rungs in front of it. That is what searching by structure means.

## Running it locally

You do not need to. **To just try it, open the [live demo](https://takashiyoshinaga.github.io/Interactive-Search/).** What follows is for running the code from a checkout.

Because it uses ES modules, you cannot open `docs/index.html` over `file://`. From the repository root, run:

```bash
node tools/serve.mjs
```

Then open [http://127.0.0.1:8000/docs/](http://127.0.0.1:8000/docs/). Use the `PORT` environment variable for a different port.

```bash
# macOS / Linux
PORT=8743 node tools/serve.mjs

# PowerShell
$env:PORT=8743; node tools/serve.mjs
```

If you have Python available, `python -m http.server 8000` from the repository root works just as well.

## Verifying during development

Install the verification dependencies once:

```bash
cd tools
npm install
cd ..
```

Put your Aura credentials file in `DoNotUpload/` before running these. That directory and `.env` are outside Git.

```bash
node tools/verify-ladder.mjs  # ladder, Cypher, look-ahead, expected counts
node tools/verify-db.mjs      # connection, precheck, graph load, error classification
node tools/bake-layout.mjs    # regenerate the deterministic layout
```

## Security and limits

- The URI, username and password stay in the tab's memory only. Nothing is written to Web Storage, cookies or the URL.
- Runtime libraries are vendored under `docs/vendor/`, and a Content Security Policy forbids third-party scripts.
- Bolt over WebSocket to Aura uses port 7687. If your organisation's or venue's network blocks it, try a different network.
- This is a teaching tool that draws the whole graph at once. It is not suited to databases beyond roughly 2,000 nodes or 5,000 relationships.
- Variable-length paths can multiply the number of results quickly. If it feels heavy, reduce the hop count or the number of rungs.

## License

[MIT License](LICENSE). Licenses for the vendored libraries are in `docs/vendor/`.
