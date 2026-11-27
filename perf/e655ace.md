# projects perf: e655ace

Commit e655ace · CPU 4× · API shape `full` · API latency 40 ms · assets cached as `workers-assets` · trace stream 20 events/s · idle window 15 s · 2026-11-27T08:01:09.257Z

| page / flow | to content | requests | transferred | API bytes | API decoded | long tasks | long total | long max | script | layout+style | API req/idle min | API bytes/idle min | worst key→paint |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| projects · cold | 700 ms | 18 | 480 KB | 0.2 KB | 0.7 KB | 4 | 484 ms | 223 ms | 431 ms | 62 ms | – | – | – |
| projects · warm | 652 ms | 18 | 0.2 KB | 0.2 KB | 0.7 KB | 4 | 447 ms | 224 ms | 404 ms | 63 ms | – | – | – |
| projects · idle | – | 1 | 0.2 KB | 0.2 KB | 0.7 KB | 0 | 0 ms | 0 ms | 4 ms | 0 ms | 4 | 0.9 KB | – |
| board · cold | 2134 ms | 30 | 673 KB | 128 KB | 786 KB | 9 | 2308 ms | 1134 ms | 1545 ms | 373 ms | – | – | – |
| board · warm | 2013 ms | 30 | 128 KB | 128 KB | 786 KB | 9 | 2246 ms | 1122 ms | 1472 ms | 361 ms | – | – | – |
| board · idle | – | 13 | 388 KB | 388 KB | 2.33 MB | 0 | 0 ms | 0 ms | 218 ms | 1 ms | 52 | 1.52 MB | – |
| board-drawer · cold | 5742 ms | 34 | 691 KB | 146 KB | 923 KB | 13 | 4399 ms | 1159 ms | 3390 ms | 712 ms | – | – | – |
| board-drawer · warm | 5251 ms | 34 | 146 KB | 146 KB | 923 KB | 12 | 3736 ms | 1101 ms | 2962 ms | 700 ms | – | – | – |
| board-drawer · idle | – | 23 | 529 KB | 397 KB | 2.42 MB | 2 | 526 ms | 469 ms | 726 ms | 60 ms | 72 | 1.55 MB | – |
| manager-chat · cold | 1654 ms | 36 | 728 KB | 138 KB | 832 KB | 7 | 1848 ms | 968 ms | 1518 ms | 286 ms | – | – | – |
| manager-chat · warm | 1486 ms | 36 | 138 KB | 138 KB | 832 KB | 7 | 1697 ms | 835 ms | 1480 ms | 300 ms | – | – | – |
| manager-chat · idle | – | 17 | 393 KB | 393 KB | 2.40 MB | 3 | 259 ms | 105 ms | 565 ms | 103 ms | 68 | 1.53 MB | – |
| manager-trace · cold | 1384 ms | 36 | 688 KB | 145 KB | 916 KB | 12 | 2737 ms | 977 ms | 2080 ms | 788 ms | – | – | – |
| manager-trace · warm | 1008 ms | 35 | 142 KB | 142 KB | 899 KB | 10 | 2553 ms | 1088 ms | 2061 ms | 574 ms | – | – | – |
| manager-trace · idle | – | 14 | 385 KB | 385 KB | 2.32 MB | 0 | 0 ms | 0 ms | 229 ms | 3 ms | 56 | 1.50 MB | – |
| reviews · cold | 1844 ms | 26 | 537 KB | 8.1 KB | 86 KB | 5 | 1575 ms | 919 ms | 1354 ms | 309 ms | – | – | – |
| reviews · warm | 1746 ms | 26 | 8.1 KB | 8.1 KB | 86 KB | 5 | 1535 ms | 910 ms | 1328 ms | 278 ms | – | – | – |
| reviews · idle | – | 9 | 21 KB | 21 KB | 152 KB | 0 | 0 ms | 0 ms | 28 ms | 0 ms | 36 | 83 KB | – |
| reviews-trace · cold | 1541 ms | 28 | 549 KB | 20 KB | 147 KB | 10 | 2676 ms | 889 ms | 2159 ms | 474 ms | – | – | – |
| reviews-trace · warm | 1176 ms | 27 | 17 KB | 17 KB | 130 KB | 11 | 3760 ms | 1233 ms | 2891 ms | 811 ms | – | – | – |
| reviews-trace · idle | – | 10 | 18 KB | 18 KB | 137 KB | 3 | 816 ms | 604 ms | 435 ms | 216 ms | 40 | 73 KB | – |
| routines · cold | 1058 ms | 30 | 545 KB | 13 KB | 81 KB | 6 | 642 ms | 235 ms | 637 ms | 141 ms | – | – | – |
| routines · warm | 1008 ms | 30 | 13 KB | 13 KB | 81 KB | 4 | 512 ms | 243 ms | 629 ms | 137 ms | – | – | – |
| routines · idle | – | 11 | 26 KB | 26 KB | 147 KB | 0 | 0 ms | 0 ms | 28 ms | 0 ms | 44 | 103 KB | – |
| routines-trace · cold | 825 ms | 32 | 558 KB | 26 KB | 141 KB | 8 | 1669 ms | 893 ms | 1459 ms | 422 ms | – | – | – |
| routines-trace · warm | 847 ms | 31 | 22 KB | 22 KB | 125 KB | 8 | 1969 ms | 1067 ms | 1651 ms | 484 ms | – | – | – |
| routines-trace · idle | – | 10 | 23 KB | 23 KB | 131 KB | 1 | 183 ms | 183 ms | 50 ms | 148 ms | 40 | 91 KB | – |
| triage · cold | 977 ms | 24 | 527 KB | 8.2 KB | 42 KB | 5 | 741 ms | 240 ms | 614 ms | 211 ms | – | – | – |
| triage · warm | 971 ms | 24 | 8.2 KB | 8.2 KB | 42 KB | 5 | 758 ms | 259 ms | 625 ms | 186 ms | – | – | – |
| triage · idle | – | 11 | 29 KB | 29 KB | 155 KB | 0 | 0 ms | 0 ms | 31 ms | 0 ms | 44 | 116 KB | – |
| secrets · cold | 977 ms | 22 | 526 KB | 5.0 KB | 32 KB | 6 | 742 ms | 229 ms | 591 ms | 190 ms | – | – | – |
| secrets · warm | 876 ms | 22 | 5.0 KB | 5.0 KB | 32 KB | 5 | 636 ms | 221 ms | 551 ms | 178 ms | – | – | – |
| secrets · idle | – | 12 | 22 KB | 22 KB | 152 KB | 0 | 0 ms | 0 ms | 30 ms | 0 ms | 48 | 90 KB | – |
| network · cold | 972 ms | 22 | 525 KB | 4.9 KB | 23 KB | 4 | 672 ms | 277 ms | 625 ms | 140 ms | – | – | – |
| network · warm | 894 ms | 22 | 4.9 KB | 4.9 KB | 23 KB | 4 | 665 ms | 282 ms | 587 ms | 124 ms | – | – | – |
| network · idle | – | 12 | 22 KB | 22 KB | 109 KB | 0 | 0 ms | 0 ms | 33 ms | 0 ms | 48 | 88 KB | – |
| settings · cold | 953 ms | 25 | 528 KB | 5.0 KB | 32 KB | 4 | 704 ms | 303 ms | 624 ms | 142 ms | – | – | – |
| settings · warm | 931 ms | 25 | 5.0 KB | 5.0 KB | 32 KB | 4 | 695 ms | 281 ms | 623 ms | 133 ms | – | – | – |
| settings · idle | – | 12 | 22 KB | 22 KB | 152 KB | 0 | 0 ms | 0 ms | 37 ms | 0 ms | 48 | 90 KB | – |
| admin · cold | 584 ms | 19 | 518 KB | 0.7 KB | 1.7 KB | 3 | 404 ms | 228 ms | 453 ms | 115 ms | – | – | – |
| admin · warm | 559 ms | 19 | 0.7 KB | 0.7 KB | 1.7 KB | 3 | 386 ms | 220 ms | 416 ms | 103 ms | – | – | – |
| admin · idle | – | 1 | 0.2 KB | 0.2 KB | 0.7 KB | 0 | 0 ms | 0 ms | 5 ms | 0 ms | 4 | 0.9 KB | – |
| switch-view · flow | 3060 ms | 13 | 195 KB | 141 KB | 897 KB | 10 | 3344 ms | 1053 ms | 2904 ms | 399 ms | – | – | – |
| switch-project · flow | 1192 ms | 7 | 43 KB | 43 KB | 243 KB | 4 | 622 ms | 259 ms | 708 ms | 82 ms | – | – | – |
| drawer · flow | 1429 ms | 7 | 145 KB | 145 KB | 921 KB | 8 | 3169 ms | 1104 ms | 2430 ms | 663 ms | – | – | 954 ms |
| type-composer · flow | – | 19 | 390 KB | 390 KB | 2.38 MB | 41 | 11325 ms | 541 ms | 10773 ms | 235 ms | – | – | 618 ms |
| stream-chat · flow | – | 10 | 138 KB | 138 KB | 886 KB | 58 | 9218 ms | 443 ms | 7900 ms | 448 ms | – | – | – |
| stream-trace · flow | – | 10 | 255 KB | 255 KB | 1.53 MB | 35 | 9048 ms | 369 ms | 8946 ms | 150 ms | – | – | – |
| open-trace · flow | 1011 ms | 4 | 17 KB | 17 KB | 128 KB | 10 | 2046 ms | 984 ms | 1750 ms | 408 ms | – | – | – |
| older-chat · flow | 3578 ms | 11 | 153 KB | 153 KB | 965 KB | 15 | 3869 ms | 853 ms | 3797 ms | 382 ms | – | – | – |
| older-trace · flow | 3227 ms | 6 | 155 KB | 155 KB | 917 KB | 15 | 2956 ms | 449 ms | 2220 ms | 113 ms | – | – | – |
| drag-reorder · flow | – | 5 | 130 KB | 130 KB | 801 KB | 6 | 1752 ms | 394 ms | 1965 ms | 49 ms | – | – | – |
| tab-switch · flow | 923 ms | 29 | 453 KB | 453 KB | 2.72 MB | 38 | 10226 ms | 975 ms | 8315 ms | 1943 ms | – | – | – |
| idle-board · flow | – | 56 | 1.52 MB | 1.52 MB | 9.33 MB | 0 | 0 ms | 0 ms | 750 ms | 2 ms | 56 | 1.52 MB | – |
| idle-manager · flow | – | 68 | 1.41 MB | 1.41 MB | 8.84 MB | 7 | 921 ms | 303 ms | 1833 ms | 458 ms | 68 | 1.41 MB | – |

Content selectors: projects `a[href='/projects/prj_demo/board'], a[href='/projects/prj_demo']`; board `[data-ds=task-row]`; board-drawer `[role=dialog] [data-ds=terminal] [data-kind=tool]`; manager-chat `[data-ds=bubble], [data-ds=message]`; manager-trace `[data-ds=terminal] [data-kind=tool]`; reviews `[aria-label^='Show the trace of #']`; reviews-trace `the click, then [data-ds=terminal] [data-kind=tool]`; routines `[aria-label='Routine runs'] [aria-label^='Show ']`; routines-trace `the click, then [data-ds=terminal] [data-kind=tool]`; triage `[data-ds=page] [data-ds=panel]`; secrets `[data-ds=page] [data-ds=table-frame], [data-ds=page] [data-ds=panel]`; network `[data-ds=page] [data-ds=panel]`; settings `[data-ds=page] [data-ds=panel]`; admin `[data-ds=page] [data-ds=panel], [data-ds=page] [data-ds=table-frame]`; switch-view `Manager, then Reviews`; switch-project `[data-task^=tsk_othe] (Widgets' board rows)`; drawer `[role=dialog] [data-ds=terminal] [data-kind=tool] (open), the dialog hidden (close)`; open-trace `[data-ds=terminal] .mantine-ScrollArea-viewport [data-kind=tool]`; older-chat `50 more messages, three times`; older-trace `a history page, three times`; tab-switch `each switch (mean)`
