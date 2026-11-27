Before: e655ace (e655ace, CPU 4×, shape full) · after: final-50b0e54 (50b0e54, CPU 4×, shape summary)

| page / flow | to content before → after | requests before → after | transferred before → after | long total before → after | script before → after | API bytes/idle min before → after | worst key→paint before → after |
|---|---:|---:|---:|---:|---:|---:|---:|
| projects · cold | 700 ms → 618 ms (-12%) | 18 → 19 (+6%) | 480 KB → 331 KB (-31%) | 484 ms → 381 ms (-21%) | 431 ms → 370 ms (-14%) | – | – |
| projects · warm | 652 ms → 567 ms (-13%) | 18 → 3 (-83%) | 0.2 KB → 0.2 KB (0%) | 447 ms → 363 ms (-19%) | 404 ms → 354 ms (-12%) | – | – |
| projects · idle | – → – | 1 → 1 (0%) | 0.2 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 5 ms → 4 ms (-18%) | 0.9 KB → 0.0 KB (-100%) | – |
| board · cold | 2134 ms → 1663 ms (-22%) | 30 → 36 (+20%) | 673 KB → 571 KB (-15%) | 2308 ms → 1463 ms (-37%) | 1545 ms → 1363 ms (-12%) | – | – |
| board · warm | 2013 ms → 1668 ms (-17%) | 30 → 7 (-77%) | 128 KB → 16 KB (-88%) | 2246 ms → 1466 ms (-35%) | 1472 ms → 1341 ms (-9%) | – | – |
| board · idle | – → – | 13 → 9 (-31%) | 388 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 219 ms → 247 ms (+13%) | 1.52 MB → 0.0 KB (-100%) | – |
| board-drawer · cold | 5742 ms → 3839 ms (-33%) | 34 → 39 (+15%) | 691 KB → 585 KB (-15%) | 4399 ms → 2198 ms (-50%) | 3390 ms → 1791 ms (-47%) | – | – |
| board-drawer · warm | 5251 ms → 3653 ms (-30%) | 34 → 10 (-71%) | 146 KB → 30 KB (-79%) | 3736 ms → 2596 ms (-31%) | 2962 ms → 2234 ms (-25%) | – | – |
| board-drawer · idle | – → – | 23 → 18 (-22%) | 529 KB → 133 KB (-75%) | 526 ms → 111 ms (-79%) | 726 ms → 425 ms (-41%) | 1.55 MB → 0.0 KB (-100%) | – |
| manager-chat · cold | 1654 ms → 1295 ms (-22%) | 36 → 43 (+19%) | 728 KB → 617 KB (-15%) | 1848 ms → 1333 ms (-28%) | 1518 ms → 1357 ms (-11%) | – | – |
| manager-chat · warm | 1486 ms → 1197 ms (-19%) | 36 → 10 (-72%) | 138 KB → 20 KB (-85%) | 1697 ms → 953 ms (-44%) | 1480 ms → 767 ms (-48%) | – | – |
| manager-chat · idle | – → – | 17 → 16 (-6%) | 393 KB → 0.0 KB (-100%) | 259 ms → 172 ms (-34%) | 565 ms → 691 ms (+22%) | 1.53 MB → 0.0 KB (-100%) | – |
| manager-trace · cold | 1384 ms → 2484 ms (+80%) | 36 → 40 (+11%) | 688 KB → 570 KB (-17%) | 2737 ms → 1025 ms (-63%) | 2080 ms → 1290 ms (-38%) | – | – |
| manager-trace · warm | 1008 ms → 1059 ms (+5%) | 35 → 12 (-66%) | 142 KB → 30 KB (-79%) | 2553 ms → 1644 ms (-36%) | 2061 ms → 1671 ms (-19%) | – | – |
| manager-trace · idle | – → – | 14 → 11 (-21%) | 385 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 229 ms → 68 ms (-70%) | 1.50 MB → 0.0 KB (-100%) | – |
| reviews · cold | 1844 ms → 1646 ms (-11%) | 26 → 28 (+8%) | 537 KB → 434 KB (-19%) | 1575 ms → 1504 ms (-5%) | 1354 ms → 1248 ms (-8%) | – | – |
| reviews · warm | 1746 ms → 1555 ms (-11%) | 26 → 7 (-73%) | 8.1 KB → 8.1 KB (0%) | 1535 ms → 1363 ms (-11%) | 1328 ms → 1219 ms (-8%) | – | – |
| reviews · idle | – → – | 9 → 5 (-44%) | 21 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 28 ms → 12 ms (-55%) | 83 KB → 0.0 KB (-100%) | – |
| reviews-trace · cold | 1541 ms → 1188 ms (-23%) | 28 → 29 (+4%) | 549 KB → 443 KB (-19%) | 2676 ms → 2204 ms (-18%) | 2159 ms → 1802 ms (-17%) | – | – |
| reviews-trace · warm | 1176 ms → 1133 ms (-4%) | 27 → 8 (-70%) | 17 KB → 17 KB (0%) | 3760 ms → 2354 ms (-37%) | 2891 ms → 1886 ms (-35%) | – | – |
| reviews-trace · idle | – → – | 10 → 5 (-50%) | 18 KB → 0.0 KB (-100%) | 816 ms → 125 ms (-85%) | 435 ms → 146 ms (-66%) | 73 KB → 0.0 KB (-100%) | – |
| routines · cold | 1058 ms → 840 ms (-21%) | 30 → 32 (+7%) | 545 KB → 442 KB (-19%) | 642 ms → 643 ms (0%) | 637 ms → 632 ms (-1%) | – | – |
| routines · warm | 1008 ms → 783 ms (-22%) | 30 → 9 (-70%) | 13 KB → 13 KB (0%) | 512 ms → 652 ms (+27%) | 629 ms → 593 ms (-6%) | – | – |
| routines · idle | – → – | 11 → 7 (-36%) | 26 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 28 ms → 12 ms (-57%) | 103 KB → 0.0 KB (-100%) | – |
| routines-trace · cold | 825 ms → 829 ms (0%) | 32 → 33 (+3%) | 558 KB → 452 KB (-19%) | 1669 ms → 1805 ms (+8%) | 1459 ms → 1670 ms (+14%) | – | – |
| routines-trace · warm | 847 ms → 1025 ms (+21%) | 31 → 10 (-68%) | 22 KB → 22 KB (0%) | 1969 ms → 1036 ms (-47%) | 1651 ms → 1014 ms (-39%) | – | – |
| routines-trace · idle | – → – | 10 → 7 (-30%) | 23 KB → 0.0 KB (-100%) | 183 ms → 94 ms (-49%) | 50 ms → 126 ms (+154%) | 91 KB → 0.0 KB (-100%) | – |
| triage · cold | 977 ms → 885 ms (-9%) | 24 → 24 (0%) | 527 KB → 357 KB (-32%) | 741 ms → 631 ms (-15%) | 614 ms → 555 ms (-10%) | – | – |
| triage · warm | 971 ms → 809 ms (-17%) | 24 → 7 (-71%) | 8.2 KB → 8.2 KB (0%) | 758 ms → 598 ms (-21%) | 625 ms → 512 ms (-18%) | – | – |
| triage · idle | – → – | 11 → 7 (-36%) | 29 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 31 ms → 15 ms (-50%) | 116 KB → 0.0 KB (-100%) | – |
| secrets · cold | 977 ms → 800 ms (-18%) | 22 → 22 (0%) | 526 KB → 355 KB (-32%) | 742 ms → 552 ms (-26%) | 591 ms → 497 ms (-16%) | – | – |
| secrets · warm | 876 ms → 757 ms (-14%) | 22 → 6 (-73%) | 5.0 KB → 5.0 KB (0%) | 636 ms → 526 ms (-17%) | 551 ms → 467 ms (-15%) | – | – |
| secrets · idle | – → – | 12 → 8 (-33%) | 22 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 30 ms → 22 ms (-26%) | 90 KB → 0.0 KB (-100%) | – |
| network · cold | 972 ms → 818 ms (-16%) | 22 → 22 (0%) | 525 KB → 355 KB (-32%) | 672 ms → 550 ms (-18%) | 625 ms → 543 ms (-13%) | – | – |
| network · warm | 894 ms → 771 ms (-14%) | 22 → 6 (-73%) | 4.9 KB → 4.9 KB (0%) | 665 ms → 536 ms (-19%) | 587 ms → 507 ms (-14%) | – | – |
| network · idle | – → – | 12 → 8 (-33%) | 22 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 33 ms → 22 ms (-34%) | 88 KB → 0.0 KB (-100%) | – |
| settings · cold | 953 ms → 879 ms (-8%) | 25 → 26 (+4%) | 528 KB → 379 KB (-28%) | 704 ms → 629 ms (-11%) | 624 ms → 570 ms (-9%) | – | – |
| settings · warm | 931 ms → 829 ms (-11%) | 25 → 6 (-76%) | 5.0 KB → 5.0 KB (0%) | 695 ms → 597 ms (-14%) | 623 ms → 553 ms (-11%) | – | – |
| settings · idle | – → – | 12 → 8 (-33%) | 22 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 38 ms → 22 ms (-41%) | 90 KB → 0.0 KB (-100%) | – |
| admin · cold | 584 ms → 475 ms (-19%) | 19 → 19 (0%) | 518 KB → 348 KB (-33%) | 404 ms → 298 ms (-26%) | 453 ms → 363 ms (-20%) | – | – |
| admin · warm | 559 ms → 486 ms (-13%) | 19 → 5 (-74%) | 0.7 KB → 0.7 KB (0%) | 386 ms → 292 ms (-24%) | 416 ms → 347 ms (-17%) | – | – |
| admin · idle | – → – | 1 → 1 (0%) | 0.2 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 5 ms → 4 ms (-24%) | 0.9 KB → 0.0 KB (-100%) | – |
| switch-view · flow | 3060 ms → 2045 ms (-33%) | 13 → 9 (-31%) | 195 KB → 69 KB (-65%) | 3344 ms → 2194 ms (-34%) | 2904 ms → 2210 ms (-24%) | – | – |
| switch-project · flow | 1192 ms → 1011 ms (-15%) | 7 → 4 (-43%) | 43 KB → 7.7 KB (-82%) | 622 ms → 326 ms (-48%) | 708 ms → 394 ms (-44%) | – | – |
| drawer · flow | 1429 ms → 1018 ms (-29%) | 7 → 3 (-57%) | 145 KB → 15 KB (-90%) | 3169 ms → 1682 ms (-47%) | 2430 ms → 1387 ms (-43%) | – | 954 ms → 315 ms (-67%) |
| type-composer · flow | – → – | 19 → 8 (-58%) | 390 KB → 0.0 KB (-100%) | 11325 ms → 52 ms (-100%) | 10773 ms → 395 ms (-96%) | – | 618 ms → 64 ms (-90%) |
| stream-chat · flow | – → – | 10 → 11 (+10%) | 138 KB → 0.0 KB (-100%) | 9218 ms → 219 ms (-98%) | 7900 ms → 2771 ms (-65%) | – | – |
| stream-trace · flow | – → – | 10 → 8 (-20%) | 255 KB → 0.0 KB (-100%) | 9048 ms → 158 ms (-98%) | 8946 ms → 3913 ms (-56%) | – | – |
| open-trace · flow | 1011 ms → 368 ms (-64%) | 4 → 0 (-100%) | 17 KB → 0.0 KB (-100%) | 2046 ms → 152 ms (-93%) | 1750 ms → 1155 ms (-34%) | – | – |
| older-chat · flow | 3578 ms → 1871 ms (-48%) | 11 → 5 (-55%) | 153 KB → 9.4 KB (-94%) | 3869 ms → 1478 ms (-62%) | 3797 ms → 1187 ms (-69%) | – | – |
| older-trace · flow | 3227 ms → 852 ms (-74%) | 6 → 5 (-17%) | 155 KB → 28 KB (-82%) | 2956 ms → 329 ms (-89%) | 2220 ms → 425 ms (-81%) | – | – |
| drag-reorder · flow | – → – | 5 → 2 (-60%) | 130 KB → 12 KB (-91%) | 1752 ms → 273 ms (-84%) | 1965 ms → 523 ms (-73%) | – | – |
| tab-switch · flow | 923 ms → 245 ms (-73%) | 29 → 5 (-83%) | 453 KB → 0.0 KB (-100%) | 10226 ms → 760 ms (-93%) | 8315 ms → 3724 ms (-55%) | – | – |
| idle-board · flow | – → – | 56 → 42 (-25%) | 1.52 MB → 0.0 KB (-100%) | 0 ms → 0 ms | 750 ms → 645 ms (-14%) | 1.52 MB → 0.0 KB (-100%) | – |
| idle-manager · flow | – → – | 68 → 72 (+6%) | 1.41 MB → 0.0 KB (-100%) | 921 ms → 258 ms (-72%) | 1833 ms → 1318 ms (-28%) | 1.41 MB → 0.0 KB (-100%) | – |
