# CBU course catalog — sources for `lib/programs.js`

StudyCore's student programs are Copperbelt University (CBU) schools / student
categories. The course codes seeded in `lib/programs.js` are the ones CBU
publishes on its own programme pages. This file records where each block came
from so the catalog can be re-checked and corrected without re-doing the
research.

**Rule:** only add a course when CBU publishes a real code for it. Where CBU
lists a course by title only (or the code is ambiguous), leave it out of the
seed and let the admin add it from the dashboard — an invented code is worse
than a missing one, because students bookmark it and content is attached to it.

**Scope:** the catalog is **first-year only**. CBU course codes carry their
year block in the hundreds digit (`BS 1xx`, `CS 2xx`, `ES 3xx` ...), so every
course seeded here is a year-1 course and each program's course list is that
school's true first-year foundation. Later-year courses are deliberately not
seeded — the admin adds them per programme from the dashboard. This keeps the
advertised course counts honest (Built Environment first year = 7, not the
full 118 across all years and degrees).

---

## School of the Built Environment (SBE) — program code `SBE`

CBU's School of the Built Environment runs five undergraduate degrees. All five
share the same `ES 1xx` first year, which is why SBE is one program with one
shared foundation block rather than five separate programs.

| Degree | CBU page |
| --- | --- |
| Bachelor of Architecture | `cbu.ac.zm/schoolsAndUnits/schoolofthebuiltenvironment/?page_id=114` |
| BSc Construction Management | `cbu.ac.zm/schoolsAndUnits/schoolofthebuiltenvironment/?page_id=121` |
| BSc Quantity Surveying | `cbu.ac.zm/schoolsAndUnits/schoolofthebuiltenvironment/?page_id=124` |
| BSc Urban and Regional Planning | `cbu.ac.zm/schoolsAndUnits/schoolofthebuiltenvironment/?page_id=128` |
| BSc Real Estate Studies | `cbu.ac.zm/schoolsAndUnits/schoolofthebuiltenvironment/?page_id=136` |
| Departments (4 departments) | `cbu.ac.zm/schoolsAndUnits/schoolofthebuiltenvironment/?page_id=18` |
| About / history | `cbu.ac.zm/schoolsAndUnits/schoolofthebuiltenvironment/?page_id=17` |
| Current programme index | `cbu.ac.zm/school/sbe/programmes` |

Seeded: the shared first year (7 courses — the `ES 1xx` foundation every
degree shares). The second- to fifth-year courses of the five degrees are not
seeded; the admin adds them per programme once the codes are confirmed.

### Naming notes (for the later-year courses the admin adds)

These rows concern the degree-specific second- to fifth-year courses that are
**not** part of the first-year seed. They record the exact code + title CBU
publishes so the admin adds the right one from the dashboard — CBU uses the
same code with two different titles on different programme pages, and the
courses table is keyed by code, so one title has to win:

| Code | Titles CBU publishes | Use when adding |
| --- | --- | --- |
| `ES 210` | "Construction and Services I" (Architecture, Real Estate) / "Construction Technology and Building Services I" (QS, Construction Management) | Construction Technology and Building Services I |
| `ES 230` | "Land Surveying" (Architecture, QS, CM) / "Land Information Systems" (Real Estate) | Land Surveying |
| `ES 461` | "Research Methods" (Architecture) / "Research Methodology" (QS) | Research Methodology |
| `ESA/B 200` | "Studio Project" / "Studio Projects" | Studio Projects |
| `ESA/B 220` | "Structures" / "Structures I" | Structures I |
| `ESB/Q 250` | "Building Economics" / "Building Economics I" | Building Economics I |

Where the same *title* appears under different codes in different degrees
(`ESA 500` / `ESB 500` / `ESQ 500` / `ESP 500` / `ESR 500` are all "Thesis
Project"), the name carries the degree in brackets so a Built Environment
student can tell them apart. The codes stay exactly as CBU writes them,
including the programme letters in `ESA/B 200`, `ES A/B 310`, `ESB/Q 250`,
`EBA/B 250`, `ESB/B 320`, `ESA/P 350` — CBU needs those letters to distinguish
near-identical courses (`ESB 310` vs `ES A/B 310`).

---

## Computer Science / SICT — program code `SICT`

| Programme | CBU page |
| --- | --- |
| BSc Computer Science | `cbu.ac.zm/sict/bachelor-of-science-in-computer-science/` (mirrored at `cbu.ac.zm/smns/bachelor-of-science-in-computer-science/`) |
| BSc Computer Engineering | `cbu.ac.zm/sict/bachelor-of-computer-engineering/` (mirrored at `cbu.ac.zm/smns/bachelor-of-computer-engineering/`) |
| SICT admission requirements | `cbu.ac.zm/schoolsAndUnits/schoolofinformationandcommunicationtechnology/adimission-requirements/` |

CBU states the SICT first year *is* the Non-Quota (School of Mathematics and
Natural Sciences) first year, which is why the shared `MA110` / `PH110`
foundation rows are attached to SICT as well as to SMMS/SMNS.

CBU re-uses two codes with different titles across its two SICT degrees —
`CS 445` is "Computer Security" in Computer Science and "Digital Electronics" in
Computer Engineering, and `CS 491` is "Special Topics in Computer Science" vs
"Digital Signal Processing". When these later-year courses are added, use the
Computer Science titles; the Computer Engineering variants are left to the
admin.

---

## Business Studies — program code `BS`

| Programme | CBU page |
| --- | --- |
| Bachelor of Accountancy (years 1–4 codes) | `cbu.ac.zm/schoolsAndUnits/lusakacampus/bachelor-of-accountancy/` |
| Bachelor of Accountancy (syllabus detail) | `cbu.ac.zm/schoolsAndUnits/schoolofbusiness/programmes/bachelor-of-accountancy/` |
| BSc Business Administration (`HRM 190`, `BF 190`, `BS 150`) | `cbu.ac.zm/schoolsAndUnits/schoolofbusiness/bachelor-science-in-business-administration-2/` |
| School of Business degrees offered | `cbu.ac.zm/schoolsAndUnits/schoolofbusiness/about/` |

`BS 110` is "Microeconomics" on the Lusaka Campus page and "Principles of
Microeconomics" on the School of Business page; the shorter title is seeded.

---

## Law — program code `LAW`

CBU publishes the full LLB structure by stage at
`ecampus.cbu.ac.zm/bachelor-of-law/`:

* **Stage I** — Constitutional, Administrative and Local Government Law; Law of
  Contract; Law of Torts; Legal Context, Skills and Ethics; Human Rights and
  Civil Liberties; Equity, Trusts and Wills; Remedies in Private Law
* **Stage II** — Criminal Law; Land Law; Employment and Labour Law; Family Law
  and Succession; Law of Evidence; Medical Law and Ethics; Conveyancing
* **Stage III** — Banking Law and Practice; Company Law and Business
  Associations; Intellectual Property Law; Media and Information Law;
  Commercial and Consumer Protection Law; Law of International Trade;
  Alternative Dispute Resolution
* **Stage IV** — Civil and Criminal Procedure Rules; Environmental and Mining
  Law; Directed Research (Dissertation); Moot Court, Legal Writing and
  Drafting; Accounting for Lawyers; Jurisprudence; Conveyancing
* **Electives** — Law of Taxation; Competition Law; Legal Aid Clinic;
  Insolvency Law; International Business Law; Investment Law; Insurance Law

The seeded `LS100`–`LS161` rows are exactly CBU's Stage I list. **Stages II–IV
are not seeded yet:** CBU publishes those titles without course codes, and
inventing `LS2xx` codes would put wrong codes in front of law students. Add
them from the admin dashboard once the LLB handbook codes are confirmed.

---

## School of Natural Resources — program code `SNR`

CBU's SNR programme pages list most courses by title only. The one page that
does publish codes is BSc Wildlife Management
(`cbu.ac.zm/snr/bachelor-of-science-in-wildlife-management/`):

* Year 1 — `NR 100` Biology, `PH 110` Physics, `NR 120` Introduction to
  Communication and Computing Skills, `NR 130` Chemistry, `MA 110` Mathematics
* Year 4 — `WM 400` Special Project, `WM 410` Wildlife Management,
  `WM 420` Conservation and Ecotourism, `WM 430` Processing and Marketing
  Wildlife Products, `WM 440` Wildlife Policy and Legislation,
  `WM 450` Wildlife Pathology and Parasitology

**Open question:** the seed currently codes SNR first-year biology as `BI100`
and chemistry as `CH130`, while CBU's Wildlife Management page codes them
`NR 100` and `NR 130`. Left unchanged so existing seeded content keeps its
course id — worth confirming with SNR before either code is edited.

Other SNR degrees (Forestry, Agroforestry, Plant & Environmental Sciences,
Sustainable Natural Resources Management & Climate Change) are listed by title
only at `cbu.ac.zm/snr/programmepes/` and
`cbu.ac.zm/schoolsAndUnits/schoolofnaturalresources/?page_id=1343` /
`?page_id=1346` / `?page_id=1347`.

---

## School of Mines and Mineral Sciences — program code `SMMS`

The shared first-year foundation (`CH110`, `MA110`, `PH110`, `CS110`, `LA111`,
`E.D`) is already seeded and matches CBU's "first year" pages.

CBU's department pages do publish codes for later years, but they are
department-specific rather than school-wide — e.g. BEng Environmental
Engineering (`cbu.ac.zm/smms/bachelors-of-engineering-in-environmental-engineering/`)
uses `BI 120`, `MA 110`, `PH 210`, `EN 210`, `ED 211`, `EN 310`, `EN 320`,
`EN 410`, `EN 411`, `EN 421`, `EN 521`, `EN 530`, `EN 531`, `EN 550`, `EN 581`,
and BEng Geomatics Engineering
(`cbu.ac.zm/smms/bachelor-of-engineering-in-geomatics-engineering/`) lists its
courses mostly by title. Those are not seeded because attaching one
department's codes to the whole School of Mines category would mislead the
other departments' students.

Programme index: `cbu.ac.zm/smms/programmes/`.

---

## CBU school list (for reference)

`cbu.ac.zm` currently lists 12 schools: Business, the Built Environment,
Engineering, Graduate Studies, Humanities and Social Sciences, Information and
Communication Technology, Mathematics and Natural Sciences, Medicine, Mines and
Mineral Sciences, Natural Resources, Law, plus the Dag Hammarskjöld Institute
for Peace and Conflict Studies and the Directorate of Distance Education and
Open Learning.
