# projects perf: final-50b0e54

Commit 50b0e54 · CPU 4× · API shape `summary` · API latency 40 ms · assets cached as `worker` · trace stream 20 events/s · idle window 15 s · 2026-11-27T10:39:28.540Z

| page / flow | to content | requests | transferred | API bytes | API decoded | long tasks | long total | long max | script | layout+style | API req/idle min | API bytes/idle min | worst key→paint |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| projects · cold | 618 ms | 19 | 331 KB | 0.2 KB | 0.7 KB | 3 | 381 ms | 214 ms | 370 ms | 60 ms | – | – | – |
| projects · warm | 567 ms | 3 | 0.2 KB | 0.2 KB | 0.7 KB | 3 | 363 ms | 215 ms | 354 ms | 59 ms | – | – | – |
| projects · idle | – | 1 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 4 ms | 0 ms | 4 | 0.0 KB | – |
| board · cold | 1663 ms | 36 | 571 KB | 16 KB | 155 KB | 4 | 1463 ms | 997 ms | 1363 ms | 211 ms | – | – | – |
| board · warm | 1668 ms | 7 | 16 KB | 16 KB | 155 KB | 4 | 1466 ms | 1025 ms | 1341 ms | 132 ms | – | – | – |
| board · idle | – | 9 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 247 ms | 0 ms | 36 | 0.0 KB | – |
| board-drawer · cold | 3839 ms | 39 | 585 KB | 30 KB | 275 KB | 7 | 2198 ms | 1345 ms | 1791 ms | 306 ms | – | – | – |
| board-drawer · warm | 3653 ms | 10 | 30 KB | 30 KB | 275 KB | 5 | 2596 ms | 1666 ms | 2234 ms | 344 ms | – | – | – |
| board-drawer · idle | – | 18 | 133 KB | 0.0 KB | 0.0 KB | 1 | 111 ms | 111 ms | 425 ms | 15 ms | 52 | 0.0 KB | – |
| manager-chat · cold | 1295 ms | 43 | 617 KB | 30 KB | 267 KB | 7 | 1333 ms | 485 ms | 1357 ms | 271 ms | – | – | – |
| manager-chat · warm | 1197 ms | 10 | 20 KB | 20 KB | 222 KB | 3 | 953 ms | 777 ms | 767 ms | 187 ms | – | – | – |
| manager-chat · idle | – | 16 | 0.0 KB | 0.0 KB | 0.0 KB | 2 | 172 ms | 98 ms | 691 ms | 152 ms | 64 | 0.0 KB | – |
| manager-trace · cold | 2484 ms | 40 | 570 KB | 30 KB | 267 KB | 5 | 1025 ms | 411 ms | 1290 ms | 149 ms | – | – | – |
| manager-trace · warm | 1059 ms | 12 | 30 KB | 30 KB | 267 KB | 5 | 1644 ms | 734 ms | 1671 ms | 193 ms | – | – | – |
| manager-trace · idle | – | 11 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 68 ms | 0 ms | 44 | 0.0 KB | – |
| reviews · cold | 1646 ms | 28 | 434 KB | 8.1 KB | 86 KB | 5 | 1504 ms | 847 ms | 1248 ms | 273 ms | – | – | – |
| reviews · warm | 1555 ms | 7 | 8.1 KB | 8.1 KB | 86 KB | 4 | 1363 ms | 830 ms | 1219 ms | 258 ms | – | – | – |
| reviews · idle | – | 5 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 12 ms | 0 ms | 20 | 0.0 KB | – |
| reviews-trace · cold | 1188 ms | 29 | 443 KB | 17 KB | 130 KB | 8 | 2204 ms | 798 ms | 1802 ms | 399 ms | – | – | – |
| reviews-trace · warm | 1133 ms | 8 | 17 KB | 17 KB | 130 KB | 9 | 2354 ms | 799 ms | 1886 ms | 416 ms | – | – | – |
| reviews-trace · idle | – | 5 | 0.0 KB | 0.0 KB | 0.0 KB | 1 | 125 ms | 125 ms | 146 ms | 19 ms | 20 | 0.0 KB | – |
| routines · cold | 840 ms | 32 | 442 KB | 13 KB | 81 KB | 4 | 643 ms | 244 ms | 631 ms | 128 ms | – | – | – |
| routines · warm | 783 ms | 9 | 13 KB | 13 KB | 81 KB | 5 | 652 ms | 237 ms | 593 ms | 119 ms | – | – | – |
| routines · idle | – | 7 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 12 ms | 0 ms | 28 | 0.0 KB | – |
| routines-trace · cold | 829 ms | 33 | 452 KB | 22 KB | 125 KB | 9 | 1805 ms | 764 ms | 1670 ms | 216 ms | – | – | – |
| routines-trace · warm | 1025 ms | 10 | 22 KB | 22 KB | 125 KB | 7 | 1036 ms | 329 ms | 1014 ms | 187 ms | – | – | – |
| routines-trace · idle | – | 7 | 0.0 KB | 0.0 KB | 0.0 KB | 1 | 94 ms | 94 ms | 126 ms | 15 ms | 28 | 0.0 KB | – |
| triage · cold | 885 ms | 24 | 357 KB | 8.2 KB | 42 KB | 4 | 631 ms | 248 ms | 555 ms | 197 ms | – | – | – |
| triage · warm | 809 ms | 7 | 8.2 KB | 8.2 KB | 42 KB | 4 | 598 ms | 219 ms | 512 ms | 165 ms | – | – | – |
| triage · idle | – | 7 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 15 ms | 0 ms | 28 | 0.0 KB | – |
| secrets · cold | 800 ms | 22 | 355 KB | 5.0 KB | 32 KB | 4 | 552 ms | 182 ms | 497 ms | 160 ms | – | – | – |
| secrets · warm | 757 ms | 6 | 5.0 KB | 5.0 KB | 32 KB | 4 | 526 ms | 186 ms | 467 ms | 152 ms | – | – | – |
| secrets · idle | – | 8 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 22 ms | 0 ms | 32 | 0.0 KB | – |
| network · cold | 818 ms | 22 | 355 KB | 4.9 KB | 23 KB | 3 | 550 ms | 275 ms | 543 ms | 115 ms | – | – | – |
| network · warm | 771 ms | 6 | 4.9 KB | 4.9 KB | 23 KB | 3 | 536 ms | 262 ms | 507 ms | 115 ms | – | – | – |
| network · idle | – | 8 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 22 ms | 0 ms | 32 | 0.0 KB | – |
| settings · cold | 879 ms | 26 | 379 KB | 5.0 KB | 32 KB | 3 | 629 ms | 303 ms | 570 ms | 116 ms | – | – | – |
| settings · warm | 829 ms | 6 | 5.0 KB | 5.0 KB | 32 KB | 3 | 597 ms | 276 ms | 553 ms | 115 ms | – | – | – |
| settings · idle | – | 8 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 22 ms | 0 ms | 32 | 0.0 KB | – |
| admin · cold | 475 ms | 19 | 348 KB | 0.7 KB | 1.7 KB | 2 | 298 ms | 200 ms | 363 ms | 85 ms | – | – | – |
| admin · warm | 486 ms | 5 | 0.7 KB | 0.7 KB | 1.7 KB | 2 | 292 ms | 197 ms | 347 ms | 84 ms | – | – | – |
| admin · idle | – | 1 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 3 ms | 0 ms | 4 | 0.0 KB | – |
| switch-view · flow | 2045 ms | 9 | 69 KB | 14 KB | 113 KB | 6 | 2194 ms | 1136 ms | 2210 ms | 264 ms | – | – | – |
| switch-project · flow | 1011 ms | 4 | 7.7 KB | 7.7 KB | 55 KB | 2 | 326 ms | 223 ms | 394 ms | 182 ms | – | – | – |
| drawer · flow | 1018 ms | 3 | 15 KB | 15 KB | 120 KB | 8 | 1682 ms | 792 ms | 1387 ms | 286 ms | – | – | 315 ms |
| type-composer · flow | – | 8 | 0.0 KB | 0.0 KB | 0.0 KB | 1 | 52 ms | 52 ms | 395 ms | 112 ms | – | – | 64 ms |
| stream-chat · flow | – | 11 | 0.0 KB | 0.0 KB | 0.0 KB | 3 | 219 ms | 82 ms | 2771 ms | 698 ms | – | – | – |
| stream-trace · flow | – | 8 | 0.0 KB | 0.0 KB | 0.0 KB | 2 | 158 ms | 100 ms | 3913 ms | 595 ms | – | – | – |
| open-trace · flow | 368 ms | 0 | 0.0 KB | 0.0 KB | 0.0 KB | 1 | 152 ms | 152 ms | 1155 ms | 97 ms | – | – | – |
| older-chat · flow | 1871 ms | 5 | 9.4 KB | 9.4 KB | 49 KB | 5 | 1478 ms | 490 ms | 1187 ms | 239 ms | – | – | – |
| older-trace · flow | 852 ms | 5 | 28 KB | 28 KB | 133 KB | 3 | 329 ms | 142 ms | 425 ms | 121 ms | – | – | – |
| drag-reorder · flow | – | 2 | 12 KB | 12 KB | 136 KB | 3 | 273 ms | 122 ms | 523 ms | 169 ms | – | – | – |
| tab-switch · flow | 245 ms | 5 | 0.0 KB | 0.0 KB | 0.0 KB | 4 | 760 ms | 234 ms | 3724 ms | 179 ms | – | – | – |
| idle-board · flow | – | 42 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 645 ms | 0 ms | 42 | 0.0 KB | – |
| idle-manager · flow | – | 72 | 0.0 KB | 0.0 KB | 0.0 KB | 3 | 258 ms | 99 ms | 1318 ms | 315 ms | 72 | 0.0 KB | – |

Content selectors: projects `a[href='/projects/prj_demo/board'], a[href='/projects/prj_demo']`; board `[data-ds=task-row]`; board-drawer `[role=dialog] [data-ds=terminal] [data-kind=tool]`; manager-chat `[data-ds=bubble], [data-ds=message]`; manager-trace `[data-ds=terminal] [data-kind=tool]`; reviews `[aria-label^='Show the trace of #']`; reviews-trace `the click, then [data-ds=terminal] [data-kind=tool]`; routines `[aria-label='Routine runs'] [aria-label^='Show ']`; routines-trace `the click, then [data-ds=terminal] [data-kind=tool]`; triage `[data-ds=page] [data-ds=panel]`; secrets `[data-ds=page] [data-ds=table-frame], [data-ds=page] [data-ds=panel]`; network `[data-ds=page] [data-ds=panel]`; settings `[data-ds=page] [data-ds=panel]`; admin `[data-ds=page] [data-ds=panel], [data-ds=page] [data-ds=table-frame]`; switch-view `Manager, then Reviews`; switch-project `[data-task^=tsk_othe] (Widgets' board rows)`; drawer `[role=dialog] [data-ds=terminal] [data-kind=tool] (open), the dialog hidden (close)`; open-trace `[data-ds=terminal] .mantine-ScrollArea-viewport [data-kind=tool]`; older-chat `50 more messages, three times`; older-trace `a history page, three times`; tab-switch `each switch (mean)`
