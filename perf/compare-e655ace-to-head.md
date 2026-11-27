Before: e655ace (e655ace, CPU 4×, shape full) · after: final-75a257d (75a257d, CPU 4×, shape summary)

| page / flow | to content before → after | requests before → after | transferred before → after | long total before → after | script before → after | API bytes/idle min before → after | worst key→paint before → after |
|---|---:|---:|---:|---:|---:|---:|---:|
| projects · cold | 700 ms → 627 ms (-10%) | 18 → 19 (+6%) | 480 KB → 331 KB (-31%) | 484 ms → 383 ms (-21%) | 431 ms → 378 ms (-12%) | – | – |
| projects · warm | 652 ms → 576 ms (-12%) | 18 → 3 (-83%) | 0.2 KB → 0.2 KB (0%) | 447 ms → 373 ms (-17%) | 404 ms → 361 ms (-11%) | – | – |
| projects · idle | – → – | 1 → 1 (0%) | 0.2 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 5 ms → 5 ms (+4%) | 0.9 KB → 0.0 KB (-100%) | – |
| board · cold | 2134 ms → 1787 ms (-16%) | 30 → 36 (+20%) | 673 KB → 571 KB (-15%) | 2308 ms → 1544 ms (-33%) | 1545 ms → 1393 ms (-10%) | – | – |
| board · warm | 2013 ms → 1665 ms (-17%) | 30 → 8 (-73%) | 128 KB → 16 KB (-87%) | 2246 ms → 1451 ms (-35%) | 1472 ms → 1314 ms (-11%) | – | – |
| board · idle | – → – | 13 → 9 (-31%) | 388 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 219 ms → 216 ms (-1%) | 1.52 MB → 0.0 KB (-100%) | – |
| board-drawer · cold | 5742 ms → 4511 ms (-21%) | 34 → 40 (+18%) | 691 KB → 586 KB (-15%) | 4399 ms → 1968 ms (-55%) | 3390 ms → 1882 ms (-44%) | – | – |
| board-drawer · warm | 5251 ms → 3774 ms (-28%) | 34 → 11 (-68%) | 146 KB → 31 KB (-79%) | 3736 ms → 1927 ms (-48%) | 2962 ms → 1847 ms (-38%) | – | – |
| board-drawer · idle | – → – | 23 → 18 (-22%) | 529 KB → 133 KB (-75%) | 526 ms → 0 ms (-100%) | 726 ms → 1204 ms (+66%) | 1.55 MB → 0.0 KB (-100%) | – |
| manager-chat · cold | 1654 ms → 1231 ms (-26%) | 36 → 42 (+17%) | 728 KB → 617 KB (-15%) | 1848 ms → 1048 ms (-43%) | 1518 ms → 920 ms (-39%) | – | – |
| manager-chat · warm | 1486 ms → 1095 ms (-26%) | 36 → 12 (-67%) | 138 KB → 30 KB (-78%) | 1697 ms → 1001 ms (-41%) | 1480 ms → 848 ms (-43%) | – | – |
| manager-chat · idle | – → – | 17 → 16 (-6%) | 393 KB → 0.0 KB (-100%) | 259 ms → 176 ms (-32%) | 565 ms → 698 ms (+24%) | 1.53 MB → 0.0 KB (-100%) | – |
| manager-trace · cold | 1384 ms → 1273 ms (-8%) | 36 → 40 (+11%) | 688 KB → 570 KB (-17%) | 2737 ms → 1734 ms (-37%) | 2080 ms → 1610 ms (-23%) | – | – |
| manager-trace · warm | 1008 ms → 890 ms (-12%) | 35 → 11 (-69%) | 142 KB → 29 KB (-79%) | 2553 ms → 1597 ms (-37%) | 2061 ms → 1574 ms (-24%) | – | – |
| manager-trace · idle | – → – | 14 → 11 (-21%) | 385 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 229 ms → 75 ms (-67%) | 1.50 MB → 0.0 KB (-100%) | – |
| reviews · cold | 1844 ms → 1564 ms (-15%) | 26 → 28 (+8%) | 537 KB → 434 KB (-19%) | 1575 ms → 1328 ms (-16%) | 1354 ms → 1207 ms (-11%) | – | – |
| reviews · warm | 1746 ms → 1834 ms (+5%) | 26 → 7 (-73%) | 8.1 KB → 8.1 KB (0%) | 1535 ms → 1688 ms (+10%) | 1328 ms → 1375 ms (+4%) | – | – |
| reviews · idle | – → – | 9 → 5 (-44%) | 21 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 28 ms → 11 ms (-62%) | 83 KB → 0.0 KB (-100%) | – |
| reviews-trace · cold | 1541 ms → 1149 ms (-25%) | 28 → 29 (+4%) | 549 KB → 443 KB (-19%) | 2676 ms → 3306 ms (+24%) | 2159 ms → 2769 ms (+28%) | – | – |
| reviews-trace · warm | 1176 ms → 1285 ms (+9%) | 27 → 8 (-70%) | 17 KB → 17 KB (0%) | 3760 ms → 2315 ms (-38%) | 2891 ms → 1919 ms (-34%) | – | – |
| reviews-trace · idle | – → – | 10 → 5 (-50%) | 18 KB → 0.0 KB (-100%) | 816 ms → 129 ms (-84%) | 435 ms → 150 ms (-65%) | 73 KB → 0.0 KB (-100%) | – |
| routines · cold | 1058 ms → 849 ms (-20%) | 30 → 32 (+7%) | 545 KB → 443 KB (-19%) | 642 ms → 685 ms (+7%) | 637 ms → 607 ms (-5%) | – | – |
| routines · warm | 1008 ms → 772 ms (-23%) | 30 → 9 (-70%) | 13 KB → 13 KB (0%) | 512 ms → 681 ms (+33%) | 629 ms → 586 ms (-7%) | – | – |
| routines · idle | – → – | 11 → 7 (-36%) | 26 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 28 ms → 11 ms (-60%) | 103 KB → 0.0 KB (-100%) | – |
| routines-trace · cold | 825 ms → 2510 ms (+204%) | 32 → 33 (+3%) | 558 KB → 452 KB (-19%) | 1669 ms → 1734 ms (+4%) | 1459 ms → 1659 ms (+14%) | – | – |
| routines-trace · warm | 847 ms → 852 ms (+1%) | 31 → 10 (-68%) | 22 KB → 22 KB (0%) | 1969 ms → 979 ms (-50%) | 1651 ms → 906 ms (-45%) | – | – |
| routines-trace · idle | – → – | 10 → 7 (-30%) | 23 KB → 0.0 KB (-100%) | 183 ms → 103 ms (-44%) | 50 ms → 133 ms (+167%) | 91 KB → 0.0 KB (-100%) | – |
| triage · cold | 977 ms → 847 ms (-13%) | 24 → 24 (0%) | 527 KB → 357 KB (-32%) | 741 ms → 615 ms (-17%) | 614 ms → 541 ms (-12%) | – | – |
| triage · warm | 971 ms → 826 ms (-15%) | 24 → 7 (-71%) | 8.2 KB → 8.2 KB (0%) | 758 ms → 609 ms (-20%) | 625 ms → 536 ms (-14%) | – | – |
| triage · idle | – → – | 11 → 7 (-36%) | 29 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 31 ms → 17 ms (-46%) | 116 KB → 0.0 KB (-100%) | – |
| secrets · cold | 977 ms → 821 ms (-16%) | 22 → 22 (0%) | 526 KB → 355 KB (-32%) | 742 ms → 526 ms (-29%) | 591 ms → 468 ms (-21%) | – | – |
| secrets · warm | 876 ms → 769 ms (-12%) | 22 → 6 (-73%) | 5.0 KB → 5.0 KB (0%) | 636 ms → 600 ms (-6%) | 551 ms → 468 ms (-15%) | – | – |
| secrets · idle | – → – | 12 → 8 (-33%) | 22 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 30 ms → 21 ms (-30%) | 90 KB → 0.0 KB (-100%) | – |
| network · cold | 972 ms → 803 ms (-17%) | 22 → 22 (0%) | 525 KB → 355 KB (-32%) | 672 ms → 540 ms (-20%) | 625 ms → 511 ms (-18%) | – | – |
| network · warm | 894 ms → 767 ms (-14%) | 22 → 6 (-73%) | 4.9 KB → 4.9 KB (0%) | 665 ms → 529 ms (-20%) | 587 ms → 500 ms (-15%) | – | – |
| network · idle | – → – | 12 → 8 (-33%) | 22 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 33 ms → 25 ms (-24%) | 88 KB → 0.0 KB (-100%) | – |
| settings · cold | 953 ms → 867 ms (-9%) | 25 → 26 (+4%) | 528 KB → 379 KB (-28%) | 704 ms → 615 ms (-13%) | 624 ms → 568 ms (-9%) | – | – |
| settings · warm | 931 ms → 821 ms (-12%) | 25 → 6 (-76%) | 5.0 KB → 5.0 KB (0%) | 695 ms → 611 ms (-12%) | 623 ms → 542 ms (-13%) | – | – |
| settings · idle | – → – | 12 → 8 (-33%) | 22 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 38 ms → 20 ms (-48%) | 90 KB → 0.0 KB (-100%) | – |
| admin · cold | 584 ms → 484 ms (-17%) | 19 → 19 (0%) | 518 KB → 348 KB (-33%) | 404 ms → 299 ms (-26%) | 453 ms → 357 ms (-21%) | – | – |
| admin · warm | 559 ms → 430 ms (-23%) | 19 → 5 (-74%) | 0.7 KB → 0.7 KB (0%) | 386 ms → 260 ms (-33%) | 416 ms → 302 ms (-27%) | – | – |
| admin · idle | – → – | 1 → 1 (0%) | 0.2 KB → 0.0 KB (-100%) | 0 ms → 0 ms | 5 ms → 4 ms (-7%) | 0.9 KB → 0.0 KB (-100%) | – |
| switch-view · flow | 3060 ms → 1875 ms (-39%) | 13 → 10 (-23%) | 195 KB → 69 KB (-65%) | 3344 ms → 1972 ms (-41%) | 2904 ms → 2025 ms (-30%) | – | – |
| switch-project · flow | 1192 ms → 1003 ms (-16%) | 7 → 4 (-43%) | 43 KB → 7.7 KB (-82%) | 622 ms → 458 ms (-26%) | 708 ms → 447 ms (-37%) | – | – |
| drawer · flow | 1429 ms → 1169 ms (-18%) | 7 → 5 (-29%) | 145 KB → 15 KB (-90%) | 3169 ms → 1708 ms (-46%) | 2430 ms → 1515 ms (-38%) | – | 954 ms → 1035 ms (+8%) |
| type-composer · flow | – → – | 19 → 8 (-58%) | 390 KB → 0.0 KB (-100%) | 11325 ms → 0 ms (-100%) | 10773 ms → 360 ms (-97%) | – | 618 ms → 63 ms (-90%) |
| stream-chat · flow | – → – | 10 → 11 (+10%) | 138 KB → 0.0 KB (-100%) | 9218 ms → 120 ms (-99%) | 7900 ms → 2852 ms (-64%) | – | – |
| stream-trace · flow | – → – | 10 → 8 (-20%) | 255 KB → 0.0 KB (-100%) | 9048 ms → 0 ms (-100%) | 8946 ms → 2413 ms (-73%) | – | – |
| open-trace · flow | 1011 ms → 320 ms (-68%) | 4 → 0 (-100%) | 17 KB → 0.0 KB (-100%) | 2046 ms → 229 ms (-89%) | 1750 ms → 1085 ms (-38%) | – | – |
| older-chat · flow | 3578 ms → 1543 ms (-57%) | 11 → 4 (-64%) | 153 KB → 9.4 KB (-94%) | 3869 ms → 1668 ms (-57%) | 3797 ms → 1321 ms (-65%) | – | – |
| older-trace · flow | 3227 ms → 1439 ms (-55%) | 6 → 2 (-67%) | 155 KB → 20 KB (-87%) | 2956 ms → 196 ms (-93%) | 2220 ms → 1052 ms (-53%) | – | – |
| drag-reorder · flow | – → – | 5 → 2 (-60%) | 130 KB → 12 KB (-91%) | 1752 ms → 210 ms (-88%) | 1965 ms → 455 ms (-77%) | – | – |
| tab-switch · flow | 923 ms → 305 ms (-67%) | 29 → 6 (-79%) | 453 KB → 9.2 KB (-98%) | 10226 ms → 1722 ms (-83%) | 8315 ms → 3621 ms (-56%) | – | – |
| idle-board · flow | – → – | 56 → 42 (-25%) | 1.52 MB → 0.0 KB (-100%) | 0 ms → 0 ms | 750 ms → 605 ms (-19%) | 1.52 MB → 0.0 KB (-100%) | – |
| idle-manager · flow | – → – | 68 → 73 (+7%) | 1.41 MB → 9.2 KB (-99%) | 921 ms → 255 ms (-72%) | 1833 ms → 1307 ms (-29%) | 1.41 MB → 9.2 KB (-99%) | – |
