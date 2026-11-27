# projects perf: main-02edb2e

Commit 02edb2e · CPU 4× · API shape `summary` · API latency 40 ms · assets cached as `worker` · trace stream 20 events/s · idle window 15 s · 2026-11-27T07:49:36.971Z

| page / flow | to content | requests | transferred | API bytes | API decoded | long tasks | long total | long max | script | layout+style | API req/idle min | API bytes/idle min | worst key→paint |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| projects · cold | 657 ms | 19 | 331 KB | 0.2 KB | 0.7 KB | 3 | 429 ms | 223 ms | 418 ms | 67 ms | – | – | – |
| projects · warm | 621 ms | 3 | 0.2 KB | 0.2 KB | 0.7 KB | 3 | 383 ms | 220 ms | 377 ms | 68 ms | – | – | – |
| projects · idle | – | 1 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 6 ms | 0 ms | 4 | 0.0 KB | – |
| board · cold | 1841 ms | 36 | 570 KB | 16 KB | 155 KB | 4 | 1592 ms | 1072 ms | 1394 ms | 167 ms | – | – | – |
| board · warm | 1862 ms | 7 | 16 KB | 16 KB | 155 KB | 3 | 1592 ms | 1393 ms | 1444 ms | 152 ms | – | – | – |
| board · idle | – | 9 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 275 ms | 5 ms | 36 | 0.0 KB | – |
| board-drawer · cold | 5063 ms | 48 | 718 KB | 31 KB | 276 KB | 9 | 3308 ms | 1025 ms | 3231 ms | 366 ms | – | – | – |
| board-drawer · warm | 3353 ms | 10 | 30 KB | 30 KB | 275 KB | 5 | 2465 ms | 1848 ms | 2098 ms | 312 ms | – | – | – |
| board-drawer · idle | – | 13 | 0.0 KB | 0.0 KB | 0.0 KB | 2 | 168 ms | 110 ms | 489 ms | 76 ms | 52 | 0.0 KB | – |
| manager-chat · cold | 1888 ms | 41 | 607 KB | 20 KB | 222 KB | 5 | 1713 ms | 1138 ms | 1364 ms | 305 ms | – | – | – |
| manager-chat · warm | 1684 ms | 12 | 30 KB | 30 KB | 267 KB | 3 | 1440 ms | 1224 ms | 1130 ms | 256 ms | – | – | – |
| manager-chat · idle | – | 15 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 279 ms | 69 ms | 60 | 0.0 KB | – |
| manager-trace · cold | 1441 ms | 40 | 569 KB | 30 KB | 267 KB | 6 | 1852 ms | 782 ms | 1815 ms | 261 ms | – | – | – |
| manager-trace · warm | 1320 ms | 12 | 30 KB | 30 KB | 267 KB | 6 | 1747 ms | 663 ms | 1733 ms | 206 ms | – | – | – |
| manager-trace · idle | – | 11 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 75 ms | 0 ms | 44 | 0.0 KB | – |
| reviews · cold | 1731 ms | 28 | 433 KB | 8.1 KB | 86 KB | 5 | 1527 ms | 855 ms | 1312 ms | 291 ms | – | – | – |
| reviews · warm | 1640 ms | 7 | 8.1 KB | 8.1 KB | 86 KB | 5 | 1521 ms | 849 ms | 1252 ms | 289 ms | – | – | – |
| reviews · idle | – | 5 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 14 ms | 0 ms | 20 | 0.0 KB | – |
| reviews-trace · cold | 1180 ms | 29 | 442 KB | 17 KB | 130 KB | 12 | 3460 ms | 855 ms | 2803 ms | 563 ms | – | – | – |
| reviews-trace · warm | 1207 ms | 8 | 17 KB | 17 KB | 130 KB | 10 | 3386 ms | 1030 ms | 2889 ms | 477 ms | – | – | – |
| reviews-trace · idle | – | 5 | 0.0 KB | 0.0 KB | 0.0 KB | 1 | 112 ms | 112 ms | 120 ms | 18 ms | 20 | 0.0 KB | – |
| routines · cold | 845 ms | 32 | 442 KB | 13 KB | 81 KB | 5 | 715 ms | 244 ms | 662 ms | 120 ms | – | – | – |
| routines · warm | 780 ms | 9 | 13 KB | 13 KB | 81 KB | 5 | 627 ms | 237 ms | 570 ms | 125 ms | – | – | – |
| routines · idle | – | 7 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 11 ms | 0 ms | 28 | 0.0 KB | – |
| routines-trace · cold | 1523 ms | 33 | 451 KB | 22 KB | 125 KB | 8 | 1224 ms | 367 ms | 1149 ms | 201 ms | – | – | – |
| routines-trace · warm | 855 ms | 10 | 22 KB | 22 KB | 125 KB | 8 | 1032 ms | 251 ms | 968 ms | 197 ms | – | – | – |
| routines-trace · idle | – | 7 | 0.0 KB | 0.0 KB | 0.0 KB | 1 | 154 ms | 154 ms | 168 ms | 17 ms | 28 | 0.0 KB | – |
| triage · cold | 888 ms | 24 | 357 KB | 8.2 KB | 42 KB | 4 | 665 ms | 263 ms | 576 ms | 193 ms | – | – | – |
| triage · warm | 858 ms | 7 | 8.2 KB | 8.2 KB | 42 KB | 4 | 655 ms | 256 ms | 570 ms | 179 ms | – | – | – |
| triage · idle | – | 7 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 21 ms | 0 ms | 28 | 0.0 KB | – |
| secrets · cold | 872 ms | 22 | 355 KB | 5.0 KB | 32 KB | 4 | 583 ms | 196 ms | 533 ms | 171 ms | – | – | – |
| secrets · warm | 783 ms | 6 | 5.0 KB | 5.0 KB | 32 KB | 4 | 557 ms | 202 ms | 494 ms | 157 ms | – | – | – |
| secrets · idle | – | 8 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 24 ms | 0 ms | 32 | 0.0 KB | – |
| network · cold | 880 ms | 22 | 355 KB | 4.9 KB | 23 KB | 3 | 576 ms | 285 ms | 557 ms | 134 ms | – | – | – |
| network · warm | 823 ms | 6 | 4.9 KB | 4.9 KB | 23 KB | 3 | 560 ms | 271 ms | 519 ms | 123 ms | – | – | – |
| network · idle | – | 8 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 23 ms | 0 ms | 32 | 0.0 KB | – |
| settings · cold | 912 ms | 26 | 379 KB | 5.0 KB | 32 KB | 3 | 656 ms | 318 ms | 584 ms | 119 ms | – | – | – |
| settings · warm | 854 ms | 6 | 5.0 KB | 5.0 KB | 32 KB | 3 | 625 ms | 295 ms | 544 ms | 128 ms | – | – | – |
| settings · idle | – | 8 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 26 ms | 0 ms | 32 | 0.0 KB | – |
| admin · cold | 490 ms | 19 | 348 KB | 0.7 KB | 1.7 KB | 3 | 367 ms | 202 ms | 381 ms | 98 ms | – | – | – |
| admin · warm | 463 ms | 5 | 0.7 KB | 0.7 KB | 1.7 KB | 2 | 299 ms | 204 ms | 359 ms | 86 ms | – | – | – |
| admin · idle | – | 1 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 5 ms | 0 ms | 4 | 0.0 KB | – |
| switch-view · flow | 2747 ms | 10 | 69 KB | 14 KB | 113 KB | 8 | 2997 ms | 1075 ms | 2526 ms | 410 ms | – | – | – |
| switch-project · flow | 1062 ms | 4 | 7.7 KB | 7.7 KB | 55 KB | 3 | 485 ms | 273 ms | 508 ms | 180 ms | – | – | – |
| drawer · flow | 1204 ms | 5 | 15 KB | 15 KB | 120 KB | 8 | 1772 ms | 923 ms | 1535 ms | 310 ms | – | – | 234 ms |
| type-composer · flow | – | 8 | 0.0 KB | 0.0 KB | 0.0 KB | 2 | 116 ms | 60 ms | 520 ms | 177 ms | – | – | 88 ms |
| stream-chat · flow | – | 12 | 9.2 KB | 9.2 KB | 44 KB | 4 | 238 ms | 72 ms | 2794 ms | 967 ms | – | – | – |
| stream-trace · flow | – | 8 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 3181 ms | 632 ms | – | – | – |
| open-trace · flow | 621 ms | 2 | 18 KB | 18 KB | 88 KB | 6 | 1373 ms | 817 ms | 1327 ms | 147 ms | – | – | – |
| older-chat · flow | 2114 ms | 7 | 22 KB | 22 KB | 110 KB | 6 | 1654 ms | 501 ms | 1357 ms | 333 ms | – | – | – |
| older-trace · flow | 957 ms | 5 | 28 KB | 28 KB | 133 KB | 3 | 398 ms | 203 ms | 452 ms | 138 ms | – | – | – |
| drag-reorder · flow | – | 2 | 12 KB | 12 KB | 136 KB | 3 | 210 ms | 83 ms | 411 ms | 172 ms | – | – | – |
| tab-switch · flow | 890 ms | 23 | 65 KB | 65 KB | 310 KB | 21 | 5497 ms | 860 ms | 5384 ms | 677 ms | – | – | – |
| idle-board · flow | – | 42 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 725 ms | 2 ms | 42 | 0.0 KB | – |
| idle-manager · flow | – | 71 | 0.0 KB | 0.0 KB | 0.0 KB | 1 | 65 ms | 65 ms | 1098 ms | 378 ms | 71 | 0.0 KB | – |

Content selectors: projects `a[href='/projects/prj_demo/board'], a[href='/projects/prj_demo']`; board `[data-ds=task-row]`; board-drawer `[role=dialog] [data-ds=terminal] [data-kind=tool]`; manager-chat `[data-ds=bubble], [data-ds=message]`; manager-trace `[data-ds=terminal] [data-kind=tool]`; reviews `[aria-label^='Show the trace of #']`; reviews-trace `the click, then [data-ds=terminal] [data-kind=tool]`; routines `[aria-label='Routine runs'] [aria-label^='Show ']`; routines-trace `the click, then [data-ds=terminal] [data-kind=tool]`; triage `[data-ds=page] [data-ds=panel]`; secrets `[data-ds=page] [data-ds=table-frame], [data-ds=page] [data-ds=panel]`; network `[data-ds=page] [data-ds=panel]`; settings `[data-ds=page] [data-ds=panel]`; admin `[data-ds=page] [data-ds=panel], [data-ds=page] [data-ds=table-frame]`; switch-view `Manager, then Reviews`; switch-project `[data-task^=tsk_othe] (Widgets' board rows)`; drawer `[role=dialog] [data-ds=terminal] [data-kind=tool] (open), the dialog hidden (close)`; open-trace `[data-ds=terminal] .mantine-ScrollArea-viewport [data-kind=tool]`; older-chat `50 more messages, three times`; older-trace `a history page, three times`; tab-switch `each switch (mean)`
