# CBU course catalog — active StudyCore programs

StudyCore's built-in university catalog now contains only the three requested
categories: School of Mines (`SMMS`), Non-Quota / NQ (`SMNS`), and SICT
(`SICT`). Their seeded courses are the first-year courses used by those
categories. Program and course rows are seeded by `lib/programs.js`.

**Course-code rule:** only seed a course when CBU publishes its code. Where a
course is listed by title only or its code is ambiguous, leave it for an admin
to add once confirmed rather than inventing a code.

**Existing databases:** startup removes the retired built-in programs (`LAW`,
`BS`, `SNR`, and `SBE`). Accounts remain but are unassigned, so affected
students can choose one of the remaining programs. Courses still assigned to
an active program are kept; resources attached to retired-only courses are
removed, while general resources with no course association are kept. Managed
local/R2 and Bunny objects for deleted resources are cleaned up in the
background. Google Drive source files are not deleted; only their StudyCore
references are removed. The separate legacy first-year cleanup also removes
empty deterministic seed rows that are no longer in the active catalog.

Expected first-year counts: School of Mines 6, Non-Quota 6, SICT 5.

---

## School of Mines — program code `SMMS`

The seeded first-year foundation is Chemistry (`CH110`), Mathematics
(`MA110`), Physics (`PH110`), Computer Science (`CS110`), Communication Skills
(`LA111`), and Engineering Drawing (`ED`).

CBU's department pages publish later-year courses, but those are
department-specific rather than school-wide. For example, BEng Environmental
Engineering (`cbu.ac.zm/smms/bachelors-of-engineering-in-environmental-engineering/`)
uses `BI 120`, `MA 110`, `PH 210`, `EN 210`, `ED 211`, `EN 310`, `EN 320`,
`EN 410`, `EN 411`, `EN 421`, `EN 521`, `EN 530`, `EN 531`, `EN 550`, and
`EN 581`; BEng Geomatics Engineering
(`cbu.ac.zm/smms/bachelor-of-engineering-in-geomatics-engineering/`) lists
courses mostly by title. Those later-year codes are not seeded school-wide.

Programme index: `cbu.ac.zm/smms/programmes/`.

---

## Non-Quota / NQ — program code `SMNS`

Non-Quota has the shared foundation courses `CH110`, `MA110`, `PH110`,
`CS110`, and `LA111`, plus Biology (`BI110`). Its course list remains distinct
from School of Mines: Biology is NQ-only and Engineering Drawing is Mines-only.

CBU states that SICT's first year is the same as the Non-Quota first year; the
shared Mathematics and Physics rows are therefore also attached to SICT.

---

## SICT — program code `SICT`

| Programme | CBU page |
| --- | --- |
| BSc Computer Science | `cbu.ac.zm/sict/bachelor-of-science-in-computer-science/` (also mirrored under `cbu.ac.zm/smns/`) |
| BSc Computer Engineering | `cbu.ac.zm/sict/bachelor-of-computer-engineering/` (also mirrored under `cbu.ac.zm/smns/`) |
| SICT admission requirements | `cbu.ac.zm/schoolsAndUnits/schoolofinformationandcommunicationtechnology/adimission-requirements/` |

The SICT seed contains shared Mathematics (`MA110`) and Physics (`PH110`),
plus the first-year Computer Science sequence (`CS120`, `CS130`, `CS150`).

CBU re-uses two codes with different titles across its two SICT degrees:
`CS 445` is "Computer Security" in Computer Science and "Digital
Electronics" in Computer Engineering; `CS 491` is "Special Topics in Computer
Science" vs "Digital Signal Processing". When confirmed later-year courses
are added, use the Computer Science titles and keep the codes exactly as CBU
publishes them.
