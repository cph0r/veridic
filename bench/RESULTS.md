# Veridic benchmark

10 public Express apps, pinned to exact commits ([repos.json](repos.json)). Reproduce with `node bench/run.mjs`. Veridic only reads the apps; it never installs or runs them.

## Summary

| Measure | Result |
|---|---|
| Routes found | **353** of 353 counted by an independent scan; 10 of 10 apps match file by file |
| Holdout apps, first run | 27 of 55 routes (49.1%) before the fix they prompted; 55 of 55 now |
| Agent-readiness issues (high + medium) | **37 of 39 confirmed by hand (94.9% precision)** |
| Tests audited | 3,105 tests: **9 assert nothing** (9 of 9 confirmed by hand), 268 only loose checks |
| Time per app | 3.9 s at most, indexing included |

## Per app

| App | Set | Routes (independent) | Read / write / destructive | GETs that write | Issues: high / med (confirmed) | Tests (assert nothing / weak) | Time |
|---|---|---:|---|---:|---|---|---:|
| [juice-shop](https://github.com/juice-shop/juice-shop/tree/399fba76194305a312693eee44f4df64bdf0c3ce) | dev | 116 (116) | 62 / 51 / 3 | 16 | 1 / 19 (18 of 20) | 2436 (4 / 263) | 3.9 s |
| [NodeGoat](https://github.com/OWASP/NodeGoat/tree/c5cb68a7084e4ae7dcc60e6a98768720a81841e8) | dev | 20 (20) | 15 / 4 / 1 | 1 | 0 / 1 (1 of 1) | 64 (0 / 4) | 837 ms |
| [hackathon-starter](https://github.com/sahat/hackathon-starter/tree/d7a20cce5e41f45f14eaf400af874f86817aea0d) | dev | 101 (101) | 65 / 32 / 4 | 15 | 2 / 13 (15 of 15) | 377 (0 / 1) | 1.2 s |
| [realworld](https://github.com/gothinkster/node-express-realworld-example-app/tree/30b68e1e881462b2f4164ea09ab4c4f5699c7b0b) | dev | 20 (20) | 11 / 9 / 0 | 0 | 0 / 0 (0 of 0) | 28 (0 / 0) | 885 ms |
| [node-express-boilerplate](https://github.com/hagopj13/node-express-boilerplate/tree/179ae84efec61b14206d0305d941daed6c6d07f9) | dev | 15 (15) | 4 / 6 / 5 | 0 | 0 / 0 (0 of 0) | 113 (0 / 0) | 802 ms |
| [proshop-v2](https://github.com/bradtraversy/proshop-v2/tree/e23e3a897e5387f39da6c59fd72cdd12e46d0815) | dev | 26 (26) | 15 / 9 / 2 | 0 | 0 / 1 (1 of 1) | 0 (0 / 0) | 812 ms |
| [node-express-mongoose-demo](https://github.com/madhums/node-express-mongoose-demo/tree/8a134ab5deeef553d6de51d91d4ed8ee378acace) | holdout | 26 (26) | 24 / 1 / 1 | 0 | 0 / 0 (0 of 0) | 12 (5 / 0) | 881 ms |
| [bulletproof-nodejs](https://github.com/santiq/bulletproof-nodejs/tree/7ce1b4690c4e96659cb1ed0d367b08b3ab35a24b) | holdout | 6 (6) | 5 / 1 / 0 | 0 | 0 / 0 (0 of 0) | 1 (0 / 0) | 740 ms |
| [express-rest-boilerplate](https://github.com/danielfsousa/express-rest-boilerplate/tree/b8bed6d7cfce3cf2ef89ec1b5e47b52dfc50e874) | holdout | 15 (15) | 4 / 8 / 3 | 0 | 0 / 0 (0 of 0) | 58 (0 / 0) | 793 ms |
| [express-mongoose-es6-rest-api](https://github.com/kunalkapadia/express-mongoose-es6-rest-api/tree/247fedde56e380fae720ce65ff65a7d0b034b3e2) | holdout | 8 (8) | 5 / 2 / 1 | 0 | 1 / 1 (2 of 2) | 16 (0 / 0) | 802 ms |

## How each number is measured

- **Routes:** Veridic's route list is compared, per file, with an independent text scan in this script that shares no code with Veridic (direct `x.get('/path')` calls and `route('/path').get()` chains, comments skipped). Code snippets kept as data (Juice Shop's `data/static/codefixes`) aren't served routes and are left out of both.
- **Holdout:** the holdout apps were run only after route discovery had been improved on the dev apps. Their first-run result is recorded before the one fix they prompted (an app handed into a function, `require('./routes')(app)`).
- **Issues:** every high and medium issue was read against the source at the pinned commit; each verdict and its reason is in [verdicts.json](verdicts.json). Low issues aren't graded.
- **Tests:** every `it`/`test` in the repo is classified by what it checks. *Assert nothing*: no assertion, or only one on a literal. *Weak*: only loose checks (`toBeTruthy`, `toBeDefined`, bare `toHaveBeenCalled()`); many are reasonable existence checks, so this column is informational.

## Known misses

- Juice Shop `PUT /api/BasketItems/:id` edits a basket item the caller may not own. Its route uses `appendUserId()`, which Veridic takes as caller scoping; the handler doesn't use it.
- bulletproof-nodejs mounts its API under `config.api.prefix`, a value only known at run time, so its routes are listed without that prefix.
