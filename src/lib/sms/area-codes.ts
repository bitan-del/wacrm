// ============================================================
// NANP area code → candidate timezones, for SMS quiet hours.
//
// TCPA quiet hours are judged in the *recipient's* local time. When a
// contact has no timezone on file, the area code is the standard proxy
// (it is what carriers and compliance tools use). It is a proxy: a
// mobile number keeps its area code when its owner moves. So:
//
//   - A code whose area spans more than one zone maps to ALL of them,
//     and quiet hours apply if ANY candidate is quiet — the send window
//     shrinks to the hours that are allowed everywhere the number could
//     plausibly be.
//   - An unknown code (or a non-NANP number) falls back to the account
//     default — the caller decides that, not this table.
//
// US states + territories + Canada. Caribbean NANP countries are left
// out on purpose (TCPA doesn't govern them; the account default applies).
// ============================================================

const ET = 'America/New_York';
const CT = 'America/Chicago';
const MT = 'America/Denver';
const AZ = 'America/Phoenix';
const PT = 'America/Los_Angeles';
const AK = 'America/Anchorage';
const HI = 'Pacific/Honolulu';
const IN_ET = 'America/Indiana/Indianapolis';
const BOISE = 'America/Boise';
const PR = 'America/Puerto_Rico';
const ON_ET = 'America/Toronto';
const MB = 'America/Winnipeg';
const SK = 'America/Regina';
const AB = 'America/Edmonton';
const BC = 'America/Vancouver';
const NS = 'America/Halifax';
const NL = 'America/St_Johns';

type Zones = readonly string[];

/** Area codes grouped by the zones they cover. */
const GROUPS: ReadonlyArray<[Zones, string]> = [
  // ---- Eastern ------------------------------------------------------
  [[ET], [
    // CT DE DC GA ME MD MA NH NJ NY NC OH PA RI SC VT VA WV
    '203 475 860 959', '302', '202 771',
    '229 404 470 478 678 706 762 770 912 943',
    '207', '227 240 301 410 443 667',
    '339 351 413 508 617 774 781 857 978', '603',
    '201 551 609 640 732 848 856 862 908 973',
    '212 315 329 332 347 363 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934',
    '252 336 472 704 743 828 910 919 980 984',
    '216 220 234 283 326 330 380 419 436 440 513 567 614 740 937',
    '215 223 267 272 412 445 484 570 582 610 717 724 814 835 878',
    '401', '803 839 843 854 864', '802',
    '276 434 540 571 703 757 804 826 948', '304 681',
    // FL (peninsula) MI (lower) KY (east) TN (east)
    '239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 863 904 941 954',
    '231 248 269 313 517 586 616 679 734 810 947 989',
    '502 606 859', '423 865',
  ].join(' ')],
  [[IN_ET], '260 317 463 574 765'],
  // ---- Split Eastern / Central -------------------------------------
  [[ET, CT], [
    '850', // FL panhandle
    '906', // MI Upper Peninsula
    '270 364', // western KY
    '931', // middle TN
  ].join(' ')],
  [[IN_ET, CT], '812 930'], // southern IN
  // ---- Central ------------------------------------------------------
  [[CT], [
    // AL AR IL IA LA MN MS MO OK WI
    '205 251 256 334 659 938', '327 479 501 870',
    '217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872',
    '319 515 563 641 712', '225 318 337 504 985',
    '218 320 507 612 651 763 952', '228 601 662 769',
    '235 314 417 557 573 636 660 816', '405 539 572 580 918',
    '262 274 353 414 534 608 715 920',
    // IN (northwest) KS (east) NE (east) TN (west) TX (most)
    '219', '316 913', '402 531', '615 629 731 901',
    '210 214 254 281 325 346 361 409 430 469 512 682 713 726 737 806 817 830 832 903 936 940 945 956 972 979',
  ].join(' ')],
  // ---- Split Central / Mountain -------------------------------------
  [[CT, MT], [
    '620 785', // western KS
    '308', // western NE
    '701', // ND
    '605', // SD
    '432', // west TX
  ].join(' ')],
  // ---- Mountain ------------------------------------------------------
  [[MT], [
    '303 719 720 970 983', // CO
    '406', // MT
    '505 575', // NM
    '385 435 801', // UT
    '307', // WY
    '915', // El Paso
  ].join(' ')],
  [[AZ], '480 520 602 623'],
  [[AZ, MT], '928'], // northern AZ incl. Navajo Nation (observes DST)
  [[BOISE, PT], '208 986'], // ID
  // ---- Pacific -------------------------------------------------------
  [[PT], [
    '209 213 279 310 323 341 350 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 738 747 760 805 818 820 831 840 858 909 916 925 949 951',
    '702 725 775', // NV
    '458 503 971', // OR
    '206 253 360 425 509 564', // WA
  ].join(' ')],
  [[PT, BOISE], '541'], // OR incl. Malheur County
  // ---- Alaska / Hawaii / territories -----------------------------------
  [[AK], '907'],
  [[HI], '808'],
  [[PR], '787 939 340'], // PR, USVI
  [['Pacific/Guam'], '671 670'], // Guam, Northern Mariana Islands
  [['Pacific/Pago_Pago'], '684'],
  // ---- Canada ------------------------------------------------------------
  [[NS], '782 902 428 506'], // NS/PEI, NB
  [[NL], '709 879'],
  [[ON_ET], [
    '226 249 289 343 365 382 387 416 437 519 548 613 647 683 705 742 753 905 942', // ON
    '263 354 367 418 438 450 468 514 579 581 819 873', // QC
  ].join(' ')],
  [[ON_ET, MB], '807'], // northwestern ON
  [[MB], '204 431 584'],
  [[SK], '306 474 639'],
  [[AB], '368 403 587 780 825'],
  [[BC], '236 257 604 672 778'],
  [[BC, AB], '250'], // BC incl. East Kootenay
  [['America/Whitehorse', AB, 'America/Iqaluit'], '867'], // territories
];

const BY_CODE: ReadonlyMap<string, Zones> = (() => {
  const map = new Map<string, Zones>();
  for (const [zones, codes] of GROUPS) {
    for (const code of codes.split(/\s+/).filter(Boolean)) {
      map.set(code, zones);
    }
  }
  return map;
})();

/** The 3-digit area code of a +1 number, or null for anything else. */
export function nanpAreaCode(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length !== 11 || !digits.startsWith('1')) return null;
  return digits.slice(1, 4);
}

/** Candidate timezones for a +1 number's area code, or null when unknown. */
export function timeZonesForPhone(phone: string | null | undefined): Zones | null {
  const code = nanpAreaCode(phone);
  return code ? (BY_CODE.get(code) ?? null) : null;
}

/** Exposed for tests: every area code in the table. */
export function knownAreaCodes(): string[] {
  return [...BY_CODE.keys()];
}
