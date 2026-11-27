# projects perf: final-75a257d

Commit 75a257d · CPU 4× · API shape `summary` · API latency 40 ms · assets cached as `worker` · trace stream 20 events/s · idle window 15 s · 2026-11-27T11:15:22.461Z

| page / flow | to content | requests | transferred | API bytes | API decoded | long tasks | long total | long max | script | layout+style | API req/idle min | API bytes/idle min | worst key→paint |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| projects · cold | 627 ms | 19 | 331 KB | 0.2 KB | 0.7 KB | 3 | 383 ms | 218 ms | 378 ms | 62 ms | – | – | – |
| projects · warm | 576 ms | 3 | 0.2 KB | 0.2 KB | 0.7 KB | 3 | 373 ms | 227 ms | 360 ms | 64 ms | – | – | – |
| projects · idle | – | 1 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 5 ms | 0 ms | 4 | 0.0 KB | – |
| board · cold | 1787 ms | 36 | 571 KB | 16 KB | 155 KB | 4 | 1544 ms | 1055 ms | 1393 ms | 154 ms | – | – | – |
| board · warm | 1665 ms | 8 | 16 KB | 16 KB | 156 KB | 4 | 1451 ms | 979 ms | 1314 ms | 152 ms | – | – | – |
| board · idle | – | 9 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 216 ms | 0 ms | 36 | 0.0 KB | – |
| board-drawer · cold | 4511 ms | 40 | 586 KB | 31 KB | 276 KB | 7 | 1968 ms | 972 ms | 1882 ms | 277 ms | – | – | – |
| board-drawer · warm | 3774 ms | 11 | 31 KB | 31 KB | 276 KB | 6 | 1927 ms | 991 ms | 1847 ms | 217 ms | – | – | – |
| board-drawer · idle | – | 18 | 133 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 1204 ms | 32 ms | 52 | 0.0 KB | – |
| manager-chat · cold | 1231 ms | 42 | 617 KB | 29 KB | 267 KB | 4 | 1048 ms | 541 ms | 920 ms | 170 ms | – | – | – |
| manager-chat · warm | 1095 ms | 12 | 30 KB | 30 KB | 267 KB | 4 | 1001 ms | 679 ms | 848 ms | 190 ms | – | – | – |
| manager-chat · idle | – | 16 | 0.0 KB | 0.0 KB | 0.0 KB | 2 | 176 ms | 98 ms | 698 ms | 170 ms | 64 | 0.0 KB | – |
| manager-trace · cold | 1273 ms | 40 | 570 KB | 30 KB | 267 KB | 8 | 1734 ms | 794 ms | 1610 ms | 207 ms | – | – | – |
| manager-trace · warm | 890 ms | 11 | 29 KB | 29 KB | 267 KB | 7 | 1597 ms | 642 ms | 1574 ms | 196 ms | – | – | – |
| manager-trace · idle | – | 11 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 75 ms | 0 ms | 44 | 0.0 KB | – |
| reviews · cold | 1564 ms | 28 | 434 KB | 8.1 KB | 86 KB | 4 | 1328 ms | 795 ms | 1207 ms | 266 ms | – | – | – |
| reviews · warm | 1834 ms | 7 | 8.1 KB | 8.1 KB | 86 KB | 3 | 1688 ms | 1450 ms | 1375 ms | 267 ms | – | – | – |
| reviews · idle | – | 5 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 10 ms | 0 ms | 20 | 0.0 KB | – |
| reviews-trace · cold | 1149 ms | 29 | 443 KB | 17 KB | 130 KB | 10 | 3306 ms | 962 ms | 2769 ms | 469 ms | – | – | – |
| reviews-trace · warm | 1285 ms | 8 | 17 KB | 17 KB | 130 KB | 9 | 2315 ms | 842 ms | 1919 ms | 417 ms | – | – | – |
| reviews-trace · idle | – | 5 | 0.0 KB | 0.0 KB | 0.0 KB | 1 | 129 ms | 129 ms | 150 ms | 26 ms | 20 | 0.0 KB | – |
| routines · cold | 849 ms | 32 | 443 KB | 13 KB | 81 KB | 5 | 685 ms | 249 ms | 606 ms | 128 ms | – | – | – |
| routines · warm | 772 ms | 9 | 13 KB | 13 KB | 81 KB | 6 | 681 ms | 229 ms | 586 ms | 122 ms | – | – | – |
| routines · idle | – | 7 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 11 ms | 0 ms | 28 | 0.0 KB | – |
| routines-trace · cold | 2510 ms | 33 | 452 KB | 22 KB | 125 KB | 8 | 1734 ms | 846 ms | 1659 ms | 214 ms | – | – | – |
| routines-trace · warm | 852 ms | 10 | 22 KB | 22 KB | 125 KB | 8 | 979 ms | 230 ms | 906 ms | 187 ms | – | – | – |
| routines-trace · idle | – | 7 | 0.0 KB | 0.0 KB | 0.0 KB | 1 | 103 ms | 103 ms | 133 ms | 12 ms | 28 | 0.0 KB | – |
| triage · cold | 847 ms | 24 | 357 KB | 8.2 KB | 42 KB | 4 | 615 ms | 236 ms | 541 ms | 187 ms | – | – | – |
| triage · warm | 826 ms | 7 | 8.2 KB | 8.2 KB | 42 KB | 4 | 609 ms | 238 ms | 536 ms | 164 ms | – | – | – |
| triage · idle | – | 7 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 17 ms | 0 ms | 28 | 0.0 KB | – |
| secrets · cold | 821 ms | 22 | 355 KB | 5.0 KB | 32 KB | 4 | 526 ms | 203 ms | 468 ms | 158 ms | – | – | – |
| secrets · warm | 769 ms | 6 | 5.0 KB | 5.0 KB | 32 KB | 5 | 600 ms | 200 ms | 468 ms | 157 ms | – | – | – |
| secrets · idle | – | 8 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 21 ms | 0 ms | 32 | 0.0 KB | – |
| network · cold | 803 ms | 22 | 355 KB | 4.9 KB | 23 KB | 3 | 540 ms | 264 ms | 511 ms | 123 ms | – | – | – |
| network · warm | 767 ms | 6 | 4.9 KB | 4.9 KB | 23 KB | 3 | 529 ms | 250 ms | 500 ms | 114 ms | – | – | – |
| network · idle | – | 8 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 25 ms | 0 ms | 32 | 0.0 KB | – |
| settings · cold | 867 ms | 26 | 379 KB | 5.0 KB | 32 KB | 3 | 615 ms | 289 ms | 568 ms | 111 ms | – | – | – |
| settings · warm | 821 ms | 6 | 5.0 KB | 5.0 KB | 32 KB | 3 | 611 ms | 289 ms | 542 ms | 114 ms | – | – | – |
| settings · idle | – | 8 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 20 ms | 0 ms | 32 | 0.0 KB | – |
| admin · cold | 484 ms | 19 | 348 KB | 0.7 KB | 1.7 KB | 2 | 299 ms | 203 ms | 357 ms | 94 ms | – | – | – |
| admin · warm | 430 ms | 5 | 0.7 KB | 0.7 KB | 1.7 KB | 2 | 260 ms | 195 ms | 302 ms | 89 ms | – | – | – |
| admin · idle | – | 1 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 4 ms | 0 ms | 4 | 0.0 KB | – |
| switch-view · flow | 1875 ms | 10 | 69 KB | 14 KB | 113 KB | 6 | 1972 ms | 1002 ms | 2025 ms | 247 ms | – | – | – |
| switch-project · flow | 1003 ms | 4 | 7.7 KB | 7.7 KB | 55 KB | 3 | 458 ms | 252 ms | 447 ms | 166 ms | – | – | – |
| drawer · flow | 1169 ms | 5 | 15 KB | 15 KB | 120 KB | 8 | 1708 ms | 817 ms | 1515 ms | 294 ms | – | – | 1035 ms |
| type-composer · flow | – | 8 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 360 ms | 112 ms | – | – | 63 ms |
| stream-chat · flow | – | 11 | 0.0 KB | 0.0 KB | 0.0 KB | 2 | 120 ms | 63 ms | 2852 ms | 698 ms | – | – | – |
| stream-trace · flow | – | 8 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 2413 ms | 565 ms | – | – | – |
| open-trace · flow | 320 ms | 0 | 0.0 KB | 0.0 KB | 0.0 KB | 2 | 229 ms | 175 ms | 1085 ms | 62 ms | – | – | – |
| older-chat · flow | 1543 ms | 4 | 9.4 KB | 9.4 KB | 49 KB | 7 | 1668 ms | 500 ms | 1321 ms | 371 ms | – | – | – |
| older-trace · flow | 1439 ms | 2 | 20 KB | 20 KB | 93 KB | 2 | 196 ms | 109 ms | 1052 ms | 88 ms | – | – | – |
| drag-reorder · flow | – | 2 | 12 KB | 12 KB | 136 KB | 2 | 210 ms | 110 ms | 455 ms | 179 ms | – | – | – |
| tab-switch · flow | 305 ms | 6 | 9.2 KB | 9.2 KB | 44 KB | 13 | 1722 ms | 349 ms | 3621 ms | 476 ms | – | – | – |
| idle-board · flow | – | 42 | 0.0 KB | 0.0 KB | 0.0 KB | 0 | 0 ms | 0 ms | 605 ms | 0 ms | 42 | 0.0 KB | – |
| idle-manager · flow | – | 73 | 9.2 KB | 9.2 KB | 44 KB | 3 | 255 ms | 96 ms | 1307 ms | 299 ms | 73 | 9.2 KB | – |

Content selectors: projects `a[href='/projects/prj_demo/board'], a[href='/projects/prj_demo']`; board `[data-ds=task-row]`; board-drawer `[role=dialog] [data-ds=terminal] [data-kind=tool]`; manager-chat `[data-ds=bubble], [data-ds=message]`; manager-trace `[data-ds=terminal] [data-kind=tool]`; reviews `[aria-label^='Show the trace of #']`; reviews-trace `the click, then [data-ds=terminal] [data-kind=tool]`; routines `[aria-label='Routine runs'] [aria-label^='Show ']`; routines-trace `the click, then [data-ds=terminal] [data-kind=tool]`; triage `[data-ds=page] [data-ds=panel]`; secrets `[data-ds=page] [data-ds=table-frame], [data-ds=page] [data-ds=panel]`; network `[data-ds=page] [data-ds=panel]`; settings `[data-ds=page] [data-ds=panel]`; admin `[data-ds=page] [data-ds=panel], [data-ds=page] [data-ds=table-frame]`; switch-view `Manager, then Reviews`; switch-project `[data-task^=tsk_othe] (Widgets' board rows)`; drawer `[role=dialog] [data-ds=terminal] [data-kind=tool] (open), the dialog hidden (close)`; open-trace `[data-ds=terminal] .mantine-ScrollArea-viewport [data-kind=tool]`; older-chat `50 more messages, three times`; older-trace `a history page, three times`; tab-switch `each switch (mean)`
