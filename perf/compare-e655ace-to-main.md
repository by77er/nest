Before: e655ace (e655ace, CPU 4×, shape full) · after: main-02edb2e (02edb2e, CPU 4×, shape summary)

| page / flow | to content before → after | requests before → after | transferred before → after | long total before → after | script before → after | API bytes/idle min before → after | worst key→paint before → after |
|---|---:|---:|---:|---:|---:|---:|---:|
| projects · cold | 700 ms → 657 ms (-6%) | 18 → 19 (+6%) | 480 KB → 331 KB (-31%) | 484 ms → 429 ms (-11%) | 431 ms → 418 ms (-3%) | – | – |
| projects · warm | 652 ms → 621 ms (-5%) | 18 → 3 (-83%) | 0.2 KB → 0.2 KB (0%) | 447 ms → 383 ms (-14%) | 404 ms → 377 ms (-7%) | – | – |
| projects · idle | – → – | 1 → 1 (0%) | 0.2 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 5 ms → 6 ms (+24%) | 0.9 KB → 0.0 KB (-100%) | – |
| board · cold | 2134 ms → 1841 ms (-14%) | 30 → 36 (+20%) | 673 KB → 570 KB (-15%) | 2308 ms → 1592 ms (-31%) | 1545 ms → 1394 ms (-10%) | – | – |
| board · warm | 2013 ms → 1862 ms (-7%) | 30 → 7 (-77%) | 128 KB → 16 KB (-88%) | 2246 ms → 1592 ms (-29%) | 1472 ms → 1444 ms (-2%) | – | – |
| board · idle | – → – | 13 → 9 (-31%) | 388 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 219 ms → 275 ms (+26%) | 1.52 MB → 0.0 KB (-100%) | – |
| board-drawer · cold | 5742 ms → 5063 ms (-12%) | 34 → 48 (+41%) | 691 KB → 718 KB (+4%) | 4399 ms → 3308 ms (-25%) | 3390 ms → 3231 ms (-5%) | – | – |
| board-drawer · warm | 5251 ms → 3353 ms (-36%) | 34 → 10 (-71%) | 146 KB → 30 KB (-79%) | 3736 ms → 2465 ms (-34%) | 2962 ms → 2098 ms (-29%) | – | – |
| board-drawer · idle | – → – | 23 → 13 (-43%) | 529 KB → 0.0 KB (-100%) | 526 ms → 168 ms (-68%) | 726 ms → 489 ms (-33%) | 1.55 MB → 0.0 KB (-100%) | – |
| manager-chat · cold | 1654 ms → 1888 ms (+14%) | 36 → 41 (+14%) | 728 KB → 607 KB (-17%) | 1848 ms → 1713 ms (-7%) | 1518 ms → 1365 ms (-10%) | – | – |
| manager-chat · warm | 1486 ms → 1684 ms (+13%) | 36 → 12 (-67%) | 138 KB → 30 KB (-78%) | 1697 ms → 1440 ms (-15%) | 1480 ms → 1130 ms (-24%) | – | – |
| manager-chat · idle | – → – | 17 → 15 (-12%) | 393 KB → 0.0 KB (-100%) | 259 ms → 0 ms (-100%) | 565 ms → 279 ms (-51%) | 1.53 MB → 0.0 KB (-100%) | – |
| manager-trace · cold | 1384 ms → 1441 ms (+4%) | 36 → 40 (+11%) | 688 KB → 569 KB (-17%) | 2737 ms → 1852 ms (-32%) | 2080 ms → 1815 ms (-13%) | – | – |
| manager-trace · warm | 1008 ms → 1320 ms (+31%) | 35 → 12 (-66%) | 142 KB → 30 KB (-79%) | 2553 ms → 1747 ms (-32%) | 2061 ms → 1734 ms (-16%) | – | – |
| manager-trace · idle | – → – | 14 → 11 (-21%) | 385 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 229 ms → 75 ms (-67%) | 1.50 MB → 0.0 KB (-100%) | – |
| reviews · cold | 1844 ms → 1731 ms (-6%) | 26 → 28 (+8%) | 537 KB → 433 KB (-19%) | 1575 ms → 1527 ms (-3%) | 1354 ms → 1312 ms (-3%) | – | – |
| reviews · warm | 1746 ms → 1640 ms (-6%) | 26 → 7 (-73%) | 8.1 KB → 8.1 KB (0%) | 1535 ms → 1521 ms (-1%) | 1328 ms → 1252 ms (-6%) | – | – |
| reviews · idle | – → – | 9 → 5 (-44%) | 21 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 28 ms → 14 ms (-49%) | 83 KB → 0.0 KB (-100%) | – |
| reviews-trace · cold | 1541 ms → 1180 ms (-23%) | 28 → 29 (+4%) | 549 KB → 442 KB (-19%) | 2676 ms → 3460 ms (+29%) | 2159 ms → 2803 ms (+30%) | – | – |
| reviews-trace · warm | 1176 ms → 1207 ms (+3%) | 27 → 8 (-70%) | 17 KB → 17 KB (0%) | 3760 ms → 3386 ms (-10%) | 2891 ms → 2889 ms (0%) | – | – |
| reviews-trace · idle | – → – | 10 → 5 (-50%) | 18 KB → 0.0 KB (-100%) | 816 ms → 112 ms (-86%) | 435 ms → 120 ms (-72%) | 73 KB → 0.0 KB (-100%) | – |
| routines · cold | 1058 ms → 845 ms (-20%) | 30 → 32 (+7%) | 545 KB → 442 KB (-19%) | 642 ms → 715 ms (+11%) | 637 ms → 662 ms (+4%) | – | – |
| routines · warm | 1008 ms → 780 ms (-23%) | 30 → 9 (-70%) | 13 KB → 13 KB (0%) | 512 ms → 627 ms (+22%) | 629 ms → 570 ms (-9%) | – | – |
| routines · idle | – → – | 11 → 7 (-36%) | 26 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 28 ms → 11 ms (-61%) | 103 KB → 0.0 KB (-100%) | – |
| routines-trace · cold | 825 ms → 1523 ms (+85%) | 32 → 33 (+3%) | 558 KB → 451 KB (-19%) | 1669 ms → 1224 ms (-27%) | 1459 ms → 1149 ms (-21%) | – | – |
| routines-trace · warm | 847 ms → 855 ms (+1%) | 31 → 10 (-68%) | 22 KB → 22 KB (0%) | 1969 ms → 1032 ms (-48%) | 1651 ms → 968 ms (-41%) | – | – |
| routines-trace · idle | – → – | 10 → 7 (-30%) | 23 KB → 0.0 KB (-100%) | 183 ms → 154 ms (-16%) | 50 ms → 168 ms (+238%) | 91 KB → 0.0 KB (-100%) | – |
| triage · cold | 977 ms → 888 ms (-9%) | 24 → 24 (0%) | 527 KB → 357 KB (-32%) | 741 ms → 665 ms (-10%) | 614 ms → 576 ms (-6%) | – | – |
| triage · warm | 971 ms → 858 ms (-12%) | 24 → 7 (-71%) | 8.2 KB → 8.2 KB (0%) | 758 ms → 655 ms (-14%) | 625 ms → 570 ms (-9%) | – | – |
| triage · idle | – → – | 11 → 7 (-36%) | 29 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 31 ms → 21 ms (-31%) | 116 KB → 0.0 KB (-100%) | – |
| secrets · cold | 977 ms → 872 ms (-11%) | 22 → 22 (0%) | 526 KB → 355 KB (-32%) | 742 ms → 583 ms (-21%) | 591 ms → 534 ms (-10%) | – | – |
| secrets · warm | 876 ms → 783 ms (-11%) | 22 → 6 (-73%) | 5.0 KB → 5.0 KB (0%) | 636 ms → 557 ms (-12%) | 551 ms → 494 ms (-10%) | – | – |
| secrets · idle | – → – | 12 → 8 (-33%) | 22 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 30 ms → 24 ms (-19%) | 90 KB → 0.0 KB (-100%) | – |
| network · cold | 972 ms → 880 ms (-9%) | 22 → 22 (0%) | 525 KB → 355 KB (-32%) | 672 ms → 576 ms (-14%) | 625 ms → 557 ms (-11%) | – | – |
| network · warm | 894 ms → 823 ms (-8%) | 22 → 6 (-73%) | 4.9 KB → 4.9 KB (0%) | 665 ms → 560 ms (-16%) | 587 ms → 519 ms (-12%) | – | – |
| network · idle | – → – | 12 → 8 (-33%) | 22 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 33 ms → 23 ms (-32%) | 88 KB → 0.0 KB (-100%) | – |
| settings · cold | 953 ms → 912 ms (-4%) | 25 → 26 (+4%) | 528 KB → 379 KB (-28%) | 704 ms → 656 ms (-7%) | 624 ms → 584 ms (-6%) | – | – |
| settings · warm | 931 ms → 854 ms (-8%) | 25 → 6 (-76%) | 5.0 KB → 5.0 KB (0%) | 695 ms → 625 ms (-10%) | 623 ms → 544 ms (-13%) | – | – |
| settings · idle | – → – | 12 → 8 (-33%) | 22 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 38 ms → 26 ms (-32%) | 90 KB → 0.0 KB (-100%) | – |
| admin · cold | 584 ms → 490 ms (-16%) | 19 → 19 (0%) | 518 KB → 348 KB (-33%) | 404 ms → 367 ms (-9%) | 453 ms → 381 ms (-16%) | – | – |
| admin · warm | 559 ms → 463 ms (-17%) | 19 → 5 (-74%) | 0.7 KB → 0.7 KB (0%) | 386 ms → 299 ms (-23%) | 416 ms → 359 ms (-14%) | – | – |
| admin · idle | – → – | 1 → 1 (0%) | 0.2 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 5 ms → 5 ms (+13%) | 0.9 KB → 0.0 KB (-100%) | – |
| switch-view · flow | 3060 ms → 2747 ms (-10%) | 13 → 10 (-23%) | 195 KB → 69 KB (-65%) | 3344 ms → 2997 ms (-10%) | 2904 ms → 2526 ms (-13%) | – | – |
| switch-project · flow | 1192 ms → 1062 ms (-11%) | 7 → 4 (-43%) | 43 KB → 7.7 KB (-82%) | 622 ms → 485 ms (-22%) | 708 ms → 508 ms (-28%) | – | – |
| drawer · flow | 1429 ms → 1204 ms (-16%) | 7 → 5 (-29%) | 145 KB → 15 KB (-90%) | 3169 ms → 1772 ms (-44%) | 2430 ms → 1535 ms (-37%) | – | 954 ms → 234 ms (-76%) |
| type-composer · flow | – → – | 19 → 8 (-58%) | 390 KB → 0.0 KB (-100%) | 11325 ms → 116 ms (-99%) | 10773 ms → 520 ms (-95%) | – | 618 ms → 88 ms (-86%) |
| stream-chat · flow | – → – | 10 → 12 (+20%) | 138 KB → 9.2 KB (-93%) | 9218 ms → 238 ms (-97%) | 7900 ms → 2794 ms (-65%) | – | – |
| stream-trace · flow | – → – | 10 → 8 (-20%) | 255 KB → 0.0 KB (-100%) | 9048 ms → 0 ms (-100%) | 8946 ms → 3181 ms (-64%) | – | – |
| open-trace · flow | 1011 ms → 621 ms (-39%) | 4 → 2 (-50%) | 17 KB → 18 KB (+11%) | 2046 ms → 1373 ms (-33%) | 1750 ms → 1327 ms (-24%) | – | – |
| older-chat · flow | 3578 ms → 2114 ms (-41%) | 11 → 7 (-36%) | 153 KB → 22 KB (-86%) | 3869 ms → 1654 ms (-57%) | 3797 ms → 1357 ms (-64%) | – | – |
| older-trace · flow | 3227 ms → 957 ms (-70%) | 6 → 5 (-17%) | 155 KB → 28 KB (-82%) | 2956 ms → 398 ms (-87%) | 2220 ms → 452 ms (-80%) | – | – |
| drag-reorder · flow | – → – | 5 → 2 (-60%) | 130 KB → 12 KB (-91%) | 1752 ms → 210 ms (-88%) | 1965 ms → 411 ms (-79%) | – | – |
| tab-switch · flow | 923 ms → 890 ms (-4%) | 29 → 23 (-21%) | 453 KB → 65 KB (-86%) | 10226 ms → 5497 ms (-46%) | 8315 ms → 5384 ms (-35%) | – | – |
| idle-board · flow | – → – | 56 → 42 (-25%) | 1.52 MB → 0.0 KB (-100%) | 0 ms → 0 ms | 750 ms → 725 ms (-3%) | 1.52 MB → 0.0 KB (-100%) | – |
| idle-manager · flow | – → – | 68 → 71 (+4%) | 1.41 MB → 0.0 KB (-100%) | 921 ms → 65 ms (-93%) | 1833 ms → 1098 ms (-40%) | 1.41 MB → 0.0 KB (-100%) | – |
