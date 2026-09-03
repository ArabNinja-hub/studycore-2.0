// =============================================
// STUDYCORE — Multi-program platform core
// -----------------------------------------------
// Single source of truth for the university
// program/category model:
//
//   StudyCore → Program → Course → Topics →
//   Notes / Videos / Past Papers / Resources /
//   Announcements
//
// A student's program (users.program_code)
// decides which courses and content they see.
// School of Mines (SMMS) and Non-Quota (SMNS)
// are stored as SEPARATE student categories
// even though they share a general academic
// platform: their course lists differ
// (E.D vs BI110).
//
// All program and course rows live in the
// database; the catalog below only SEEDS the
// database on first boot. After that the admin
// dashboard manages programs and courses
// without any code changes.
//
// PROGRAMS ARE CBU SCHOOLS/CATEGORIES:
// Law, Business Studies, School of Natural
// Resources, School of Mines, Non-Quota, SICT
// and the School of the Built Environment (SBE,
// covering Architecture, Construction
// Management, Quantity Surveying, Real Estate
// Studies and Urban & Regional Planning).
//
// Course codes below are the ones Copperbelt
// University publishes on its own programme
// pages — see docs/cbu-course-catalog.md for
// the exact page each block came from. Do not
// invent a code for a course CBU has not
// published one for; add it through the admin
// dashboard instead so it is easy to correct.
// =============================================

const PROGRAM_CATALOG = [
  {
    code: 'LAW',
    name: 'Law',
    shortName: 'Law',
    groupName: null,
    icon: 'shield',
    description: 'Faculty of Law — constitutional, contract, tort and human-rights law.'
  },
  {
    code: 'BS',
    name: 'Business Studies',
    shortName: 'Business',
    groupName: null,
    icon: 'wallet',
    description: 'Business, management, accounting and entrepreneurship. Courses are added by the admin.'
  },
  {
    code: 'SNR',
    name: 'School of Natural Resources',
    shortName: 'SNR',
    groupName: null,
    icon: 'leaf',
    description: 'School of Natural Resources — biology, physics, chemistry, mathematics and communication.'
  },
  {
    code: 'SMMS',
    name: 'School of Mines',
    shortName: 'Mines',
    // Mines and Non-Quota share the same general academic platform and are
    // visually grouped together, but they remain SEPARATE categories.
    groupName: 'School of Mines / Non-Quota',
    icon: 'shapes',
    description: 'School of Mines — chemistry, mathematics, physics, computer science, communication and engineering drawing.'
  },
  {
    code: 'SMNS',
    name: 'Non-Quota',
    shortName: 'Non-Quota',
    groupName: 'School of Mines / Non-Quota',
    icon: 'shapes',
    description: 'Non-Quota — shared foundation sciences plus biology.'
  },
  {
    code: 'SICT',
    name: 'Computer Science / SICT',
    shortName: 'SICT',
    groupName: null,
    icon: 'code',
    description: 'School of Information and Communication Technology — computer science, mathematics and physics.'
  },
  {
    code: 'SBE',
    name: 'School of the Built Environment',
    shortName: 'Built Environment',
    groupName: null,
    icon: 'home',
    description: 'School of the Built Environment — architecture, construction management, quantity surveying, real estate studies and urban & regional planning.'
  }
];

// Every seed course is GLOBAL (one row keyed by code) and attached to the
// programs that teach it. The same code can legitimately belong to several
// programs (MA110, PH110, ...) — that sharing is the entire point of the
// program_courses join table.
//
// `subject` mirrors the legacy subjects table so seeded content also appears
// on the legacy subject pages; it is best-effort metadata only.
const COURSE_CATALOG = [
  // ---- Law ----
  { code: 'LS100', name: 'Constitutional, Administrative and Local Government Law', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS110', name: 'Law of Contract', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS120', name: 'Law of Torts', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS131', name: 'Legal Context Skills & Ethics', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS141', name: 'Human Rights and Civil Liberties', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS151', name: 'Equity, Trusts & Wills', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS161', name: 'Remedies in Private Law', subject: null, icon: 'book-open', programs: ['LAW'] },

  // ---- Business Studies — School of Business, BAcc years 1–4 (cbu.ac.zm) ----
  { code: 'BS 110', name: 'Microeconomics', subject: null, icon: 'chart', programs: ['BS'] },
  { code: 'BS 120', name: 'Basic Financial Accounting', subject: null, icon: 'calculator', programs: ['BS'] },
  { code: 'BS 140', name: 'Mathematical Analysis', subject: 'Mathematics', icon: 'calculator', programs: ['BS'] },
  { code: 'BS 150', name: 'Principles of Management', subject: null, icon: 'list-checks', programs: ['BS'] },
  { code: 'BS 151', name: 'Business Communication', subject: 'Communication Skills', icon: 'message', programs: ['BS'] },
  { code: 'BS 153', name: 'Business Environment', subject: null, icon: 'globe', programs: ['BS'] },
  { code: 'BS 190', name: 'Business Law', subject: null, icon: 'shield', programs: ['BS'] },
  { code: 'HRM 190', name: 'Principles of Law', subject: null, icon: 'shield', programs: ['BS'] },
  { code: 'BS 210', name: 'Intermediate Economic Theory', subject: null, icon: 'chart', programs: ['BS'] },
  { code: 'BS 221', name: 'Managerial Finance', subject: null, icon: 'wallet', programs: ['BS'] },
  { code: 'BS 222', name: 'Management Accounting', subject: null, icon: 'calculator', programs: ['BS'] },
  { code: 'BS 240', name: 'Introduction to Data Processing', subject: null, icon: 'code', programs: ['BS'] },
  { code: 'BS 242', name: 'Quantitative Methods', subject: 'Mathematics', icon: 'calculator', programs: ['BS'] },
  { code: 'BS 260', name: 'Principles of Marketing', subject: null, icon: 'trending-up', programs: ['BS'] },
  { code: 'BS 320', name: 'Financial Reporting', subject: null, icon: 'chart', programs: ['BS'] },
  { code: 'BS 322', name: 'Management Accounting II', subject: null, icon: 'calculator', programs: ['BS'] },
  { code: 'BS 325', name: 'Audit and Assurance', subject: null, icon: 'check-list', programs: ['BS'] },
  { code: 'BS 327', name: 'Taxation', subject: null, icon: 'wallet', programs: ['BS'] },
  { code: 'BS 341', name: 'Operations Research', subject: null, icon: 'sigma', programs: ['BS'] },
  { code: 'BS 343', name: 'Production and Operations Management', subject: null, icon: 'gauge', programs: ['BS'] },
  { code: 'BS 390', name: 'Company Law', subject: null, icon: 'shield', programs: ['BS'] },
  { code: 'BS 420', name: 'Advanced Financial Reporting', subject: null, icon: 'chart', programs: ['BS'] },
  { code: 'BS 421', name: 'Corporate Finance', subject: null, icon: 'wallet', programs: ['BS'] },
  { code: 'BS 422', name: 'Contemporary Issues in Accounting', subject: null, icon: 'book-open', programs: ['BS'] },
  { code: 'BS 425', name: 'Advanced Auditing and Assurance', subject: null, icon: 'check-list', programs: ['BS'] },
  { code: 'BS 427', name: 'Accounting Information Systems', subject: null, icon: 'code', programs: ['BS'] },
  { code: 'BS 429', name: 'Internship', subject: null, icon: 'clipboard-check', programs: ['BS'] },
  { code: 'BS 450', name: 'Strategic Management', subject: null, icon: 'target', programs: ['BS'] },

  // ---- Shared Mines / Non-Quota foundation ----
  { code: 'CH110', name: 'Chemistry', subject: 'Chemistry', icon: 'flask', programs: ['SMMS', 'SMNS'] },
  { code: 'MA110', name: 'Mathematics', subject: 'Mathematics', icon: 'calculator', programs: ['SMMS', 'SMNS', 'SICT', 'SNR'] },
  { code: 'PH110', name: 'Physics', subject: 'Physics', icon: 'atom', programs: ['SMMS', 'SMNS', 'SICT', 'SNR'] },
  { code: 'CS110', name: 'Computer Science', subject: 'Programming', icon: 'code', programs: ['SMMS', 'SMNS'] },
  { code: 'LA111', name: 'Communication Skills', subject: 'Communication Skills', icon: 'message', programs: ['SMMS', 'SMNS'] },

  // ---- School of Mines ONLY ----
  { code: 'ED', name: 'Engineering Drawing', subject: null, icon: 'ruler', programs: ['SMMS'] },

  // ---- Non-Quota ONLY ----
  { code: 'BI110', name: 'Biology', subject: 'Biology', icon: 'dna', programs: ['SMNS'] },

  // ---- SICT ----
  { code: 'CS120', name: 'Computer Science — CS120', subject: 'Programming', icon: 'code', programs: ['SICT'] },
  { code: 'CS130', name: 'Computer Science — CS130', subject: 'Programming', icon: 'code', programs: ['SICT'] },
  { code: 'CS150', name: 'Computer Science — CS150', subject: 'Programming', icon: 'code', programs: ['SICT'] },

  // ---- SICT — BSc Computer Science, years 2–4 (cbu.ac.zm/sict) ----
  { code: 'CS 220', name: 'Computer Architecture and Organisation', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 225', name: 'Introduction to Operating Systems', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 230', name: 'Software Engineering', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 235', name: 'Database Systems', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 250', name: 'Data Structures, Algorithms and Programming (C++)', subject: 'Programming', icon: 'code', programs: ['SICT'] },
  { code: 'MA 210', name: 'Engineering Mathematics I', subject: 'Mathematics', icon: 'calculator', programs: ['SICT'] },
  { code: 'PH 212', name: 'Physics II', subject: 'Physics', icon: 'atom', programs: ['SICT'] },
  { code: 'CS 301', name: 'Project Management', subject: null, icon: 'list-checks', programs: ['SICT'] },
  { code: 'CS 320', name: 'Computer Communication and Parallel Processing', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 345', name: 'Compiler Construction and Theory of Automata', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 350', name: 'Object Oriented Programming (Java)', subject: 'Programming', icon: 'code', programs: ['SICT'] },
  { code: 'CS 351', name: 'Numerical Analysis', subject: null, icon: 'calculator', programs: ['SICT'] },
  { code: 'CS 361', name: 'Introduction to Web Programming', subject: 'Programming', icon: 'code', programs: ['SICT'] },
  { code: 'MA 320', name: 'Statistics and Discrete Mathematics', subject: 'Mathematics', icon: 'calculator', programs: ['SICT'] },
  { code: 'CS 400', name: 'Major Project and Seminars', subject: null, icon: 'file-text', programs: ['SICT'] },
  { code: 'CS 422', name: 'Real-Time Systems', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 425', name: 'Computer Graphics', subject: null, icon: 'image', programs: ['SICT'] },
  { code: 'CS 432', name: 'Object-Oriented Software Engineering', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 435', name: 'Advanced Databases', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 445', name: 'Computer Security', subject: null, icon: 'shield', programs: ['SICT'] },
  { code: 'CS 453', name: 'Systems Modelling and Simulation', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 455', name: 'Mobile Programming', subject: 'Programming', icon: 'smartphone', programs: ['SICT'] },
  { code: 'CS 460', name: 'Internet Technologies', subject: null, icon: 'globe', programs: ['SICT'] },
  { code: 'CS 471', name: 'Introduction to Artificial Intelligence', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 473', name: 'Human Computer Interface', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 480', name: 'Mobile Networks', subject: null, icon: 'globe', programs: ['SICT'] },
  { code: 'CS 491', name: 'Special Topics in Computer Science', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'MG 411', name: 'Management Skills and Entrepreneurship', subject: null, icon: 'wallet', programs: ['SICT'] },

  // ---- SICT — BSc Computer Engineering, years 2–4 (cbu.ac.zm/sict) ----
  // CBU re-uses CS 445 and CS 491 with different titles in the two SICT
  // programmes (Digital Electronics / Digital Signal Processing). The courses
  // table is keyed by code, so the BSc Computer Science titles win; the
  // Computer Engineering variants are added under their own codes only.
  { code: 'CS 270', name: 'Introduction to Computer Engineering', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 321', name: 'Data Communications and Networking', subject: null, icon: 'globe', programs: ['SICT'] },
  { code: 'CS 322', name: 'Real-Time Systems (Engineering)', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 340', name: 'Processor Microarchitecture', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 341', name: 'Analog Electronics', subject: null, icon: 'zap', programs: ['SICT'] },
  { code: 'CS 365', name: 'Computer Instruction Set Architecture', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 391', name: 'Signals and Systems', subject: null, icon: 'activity', programs: ['SICT'] },
  { code: 'CS 397', name: 'Fundamentals of Robotics', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 421', name: 'Implementing System on Chip Designs', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 441', name: 'System Architecture', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 442', name: 'Microcontrollers', subject: null, icon: 'code', programs: ['SICT'] },
  { code: 'CS 495', name: 'Special Topics in Computer Engineering', subject: null, icon: 'code', programs: ['SICT'] },

  // ---- School of Natural Resources ----
  { code: 'BI100', name: 'Biology', subject: 'Biology', icon: 'dna', programs: ['SNR'] },
  { code: 'CH130', name: 'Chemistry', subject: 'Chemistry', icon: 'flask', programs: ['SNR'] },
  { code: 'NR120', name: 'Communication Skills', subject: 'Communication Skills', icon: 'message', programs: ['SNR'] },

  // ============================================================
  // School of the Built Environment (SBE)
  // ------------------------------------------------------------
  // Every code and title below is taken from CBU's own programme
  // pages for the five SBE undergraduate degrees:
  //   cbu.ac.zm/schoolsAndUnits/schoolofthebuiltenvironment/
  //     ?page_id=114  Bachelor of Architecture
  //     ?page_id=121  BSc Construction Management
  //     ?page_id=124  BSc Quantity Surveying
  //     ?page_id=128  BSc Urban and Regional Planning
  //     ?page_id=136  BSc Real Estate Studies
  // Codes that CBU writes with a programme letter ("ESA/B 200",
  // "ESB/Q 250") keep that letter, because CBU uses the letter to
  // tell near-identical courses apart (ESB 310 vs ES A/B 310).
  // ============================================================

  // ---- SBE — shared first year (all five degrees) ----
  { code: 'ES 100', name: 'Studio Project', subject: null, icon: 'pen', programs: ['SBE'] },
  { code: 'ES 110', name: 'Built Environment', subject: null, icon: 'home', programs: ['SBE'] },
  { code: 'ES 120', name: 'Introduction to Economics', subject: null, icon: 'chart', programs: ['SBE'] },
  { code: 'ES 130', name: 'Introduction to Physical and Human Geography', subject: null, icon: 'globe', programs: ['SBE'] },
  { code: 'ES 141', name: 'Introduction to Sociology', subject: null, icon: 'users', programs: ['SBE'] },
  { code: 'ES 142', name: 'Communication Skills', subject: 'Communication Skills', icon: 'message', programs: ['SBE'] },
  { code: 'ES 150', name: 'Mathematics', subject: 'Mathematics', icon: 'calculator', programs: ['SBE'] },

  // ---- SBE — shared second year (Architecture, Construction Management, Quantity Surveying) ----
  // ES 210 is "Construction and Services I" on the Architecture and Real
  // Estate pages and "Construction Technology and Building Services I" on
  // the Quantity Surveying / Construction Management pages — same code, so
  // the fuller CEM title is used here.
  { code: 'ESA/B 200', name: 'Studio Projects', subject: null, icon: 'pen', programs: ['SBE'] },
  { code: 'ES 210', name: 'Construction Technology and Building Services I', subject: null, icon: 'ruler', programs: ['SBE'] },
  { code: 'ESA/B 220', name: 'Structures I', subject: null, icon: 'shapes', programs: ['SBE'] },
  { code: 'ES 230', name: 'Land Surveying', subject: null, icon: 'ruler', programs: ['SBE'] },
  { code: 'ESB/Q 250', name: 'Building Economics I', subject: null, icon: 'wallet', programs: ['SBE'] },
  { code: 'ES 261', name: 'Computer Application', subject: null, icon: 'code', programs: ['SBE'] },
  { code: 'ES 262', name: 'Statistics', subject: null, icon: 'chart', programs: ['SBE'] },

  // ---- SBE — Bachelor of Architecture ----
  { code: 'ES 240', name: 'History of Settlements', subject: null, icon: 'library', programs: ['SBE'] },
  { code: 'EBA/B 250', name: 'Building Economics for Architects', subject: null, icon: 'wallet', programs: ['SBE'] },
  { code: 'ESA 300', name: 'Studio Project (Year 3)', subject: null, icon: 'pen', programs: ['SBE'] },
  { code: 'ES A/B 310', name: 'Construction and Services II', subject: null, icon: 'ruler', programs: ['SBE'] },
  { code: 'ESB/B 320', name: 'Structures II', subject: null, icon: 'shapes', programs: ['SBE'] },
  { code: 'ESA 330', name: 'Environmental Design I', subject: null, icon: 'pen', programs: ['SBE'] },
  { code: 'ES 340', name: 'Legal Studies', subject: null, icon: 'shield', programs: ['SBE'] },
  { code: 'ESA/P 350', name: 'Design Theory', subject: null, icon: 'pen', programs: ['SBE'] },
  { code: 'ESA 361', name: 'CAD in Architecture', subject: null, icon: 'code', programs: ['SBE'] },
  { code: 'ESA 400', name: 'Studio Project (Year 4)', subject: null, icon: 'pen', programs: ['SBE'] },
  { code: 'ES A/B 410', name: 'Construction and Services III', subject: null, icon: 'ruler', programs: ['SBE'] },
  { code: 'ESB/B 420', name: 'Landscape Design', subject: null, icon: 'pen', programs: ['SBE'] },
  { code: 'ESA 430', name: 'Environmental Design II', subject: null, icon: 'pen', programs: ['SBE'] },
  { code: 'ES A 440', name: 'Urban Design', subject: null, icon: 'globe', programs: ['SBE'] },
  { code: 'ESA 452', name: 'Construction, Restoration and Maintenance of Buildings', subject: null, icon: 'home', programs: ['SBE'] },
  { code: 'ESA 455', name: 'Interior Design', subject: null, icon: 'pen', programs: ['SBE'] },
  { code: 'ES 461', name: 'Research Methodology', subject: null, icon: 'book-open', programs: ['SBE'] },
  { code: 'ESA 500', name: 'Thesis Project (Architecture)', subject: null, icon: 'file-text', programs: ['SBE'] },
  { code: 'ES 510', name: 'Housing Economics and Policies', subject: null, icon: 'home', programs: ['SBE'] },
  { code: 'ESA 520', name: 'Project Management', subject: null, icon: 'list-checks', programs: ['SBE'] },
  { code: 'ESA 530', name: 'Professional Practice', subject: null, icon: 'award', programs: ['SBE'] },
  { code: 'ESA 550', name: 'Introduction to Intellectual Property Rights', subject: null, icon: 'shield', programs: ['SBE'] },
  { code: 'ESA 593', name: 'Practical Training (Architecture)', subject: null, icon: 'clipboard-check', programs: ['SBE'] },

  // ---- SBE — BSc Construction Management ----
  { code: 'ESB 261', name: 'Building Economics II', subject: null, icon: 'wallet', programs: ['SBE'] },
  { code: 'ESB 300', name: 'Measurement Studio II', subject: null, icon: 'ruler', programs: ['SBE'] },
  { code: 'ESB 310', name: 'Construction Technology and Building Services II', subject: null, icon: 'ruler', programs: ['SBE'] },
  { code: 'ESA 320', name: 'Structures II (Construction)', subject: null, icon: 'shapes', programs: ['SBE'] },
  { code: 'ESB 330', name: 'Measurements I', subject: null, icon: 'ruler', programs: ['SBE'] },
  { code: 'ESB 340', name: 'Legal Studies (Construction)', subject: null, icon: 'shield', programs: ['SBE'] },
  { code: 'ESB 400', name: 'Building Studio', subject: null, icon: 'pen', programs: ['SBE'] },
  { code: 'ESB 410', name: 'Construction Technology and Building Services III', subject: null, icon: 'ruler', programs: ['SBE'] },
  { code: 'ESB 420', name: 'Building Management I', subject: null, icon: 'home', programs: ['SBE'] },
  { code: 'ESB 430', name: 'Maintenance of Buildings', subject: null, icon: 'home', programs: ['SBE'] },
  { code: 'ESB 440', name: 'Construction Law', subject: null, icon: 'shield', programs: ['SBE'] },
  { code: 'ESB 450', name: 'Building Economics III', subject: null, icon: 'wallet', programs: ['SBE'] },
  { code: 'ESB 461', name: 'Research Methodology (Construction)', subject: null, icon: 'book-open', programs: ['SBE'] },
  { code: 'ESB 500', name: 'Thesis Project (Construction Management)', subject: null, icon: 'file-text', programs: ['SBE'] },
  { code: 'ESB 510', name: 'Professional Practice (Construction Management)', subject: null, icon: 'award', programs: ['SBE'] },
  { code: 'ESB 520', name: 'Building Management II', subject: null, icon: 'home', programs: ['SBE'] },
  { code: 'ESB 530', name: 'Advanced Construction Technology', subject: null, icon: 'ruler', programs: ['SBE'] },
  { code: 'ESB 550', name: 'Introduction to Intellectual Property Rights (Construction)', subject: null, icon: 'shield', programs: ['SBE'] },
  { code: 'ESB 593', name: 'Practical Training (Construction Management)', subject: null, icon: 'clipboard-check', programs: ['SBE'] },

  // ---- SBE — BSc Quantity Surveying ----
  { code: 'ESQ 400', name: 'Measurement Studio', subject: null, icon: 'ruler', programs: ['SBE'] },
  { code: 'ESQ 410', name: 'Construction Technology and Building Services III (QS)', subject: null, icon: 'ruler', programs: ['SBE'] },
  { code: 'ESQ 420', name: 'Theory and Practice of Quantity Surveying', subject: null, icon: 'calculator', programs: ['SBE'] },
  { code: 'ESQ 430', name: 'Measurements II', subject: null, icon: 'ruler', programs: ['SBE'] },
  { code: 'ESQ 440', name: 'Construction Law (QS)', subject: null, icon: 'shield', programs: ['SBE'] },
  { code: 'ESQ 450', name: 'Building Economics III (QS)', subject: null, icon: 'wallet', programs: ['SBE'] },
  { code: 'ESQ 500', name: 'Thesis Project (Quantity Surveying)', subject: null, icon: 'file-text', programs: ['SBE'] },
  { code: 'ESQ 510', name: 'Professional Practice (Quantity Surveying)', subject: null, icon: 'award', programs: ['SBE'] },
  { code: 'ESQ 520', name: 'Project Management (Quantity Surveying)', subject: null, icon: 'list-checks', programs: ['SBE'] },
  { code: 'ESQ 530', name: 'Measurement III', subject: null, icon: 'ruler', programs: ['SBE'] },
  { code: 'ESQ 550', name: 'Introduction to Intellectual Property Rights (QS)', subject: null, icon: 'shield', programs: ['SBE'] },
  { code: 'ESQ 593', name: 'Practical Training (Quantity Surveying)', subject: null, icon: 'clipboard-check', programs: ['SBE'] },

  // ---- SBE — BSc Urban and Regional Planning ----
  { code: 'ESP 200', name: 'Rural Planning Studio', subject: null, icon: 'pen', programs: ['SBE'] },
  { code: 'ESP 210', name: 'Construction and Services', subject: null, icon: 'ruler', programs: ['SBE'] },
  { code: 'ESP 220', name: 'Economics of Rural Development', subject: null, icon: 'chart', programs: ['SBE'] },
  { code: 'ESP 230', name: 'Land Surveying (Planning)', subject: null, icon: 'ruler', programs: ['SBE'] },
  { code: 'ESP 241', name: 'History of Settlements (Planning)', subject: null, icon: 'library', programs: ['SBE'] },
  { code: 'ESP 250', name: 'Introduction to Socio-Economic Surveys and Statistics for Planners', subject: null, icon: 'chart', programs: ['SBE'] },
  { code: 'ESP 253', name: 'Computer Applications', subject: null, icon: 'code', programs: ['SBE'] },
  { code: 'ESP 300', name: 'Urban Planning Studio', subject: null, icon: 'pen', programs: ['SBE'] },
  { code: 'ESP 310', name: 'Urban Economics and Quantitative Methods for Planners', subject: null, icon: 'chart', programs: ['SBE'] },
  { code: 'ESP 321', name: 'Land Surveying II', subject: null, icon: 'ruler', programs: ['SBE'] },
  { code: 'ESP 322', name: 'Environmental Economics and Management', subject: null, icon: 'leaf', programs: ['SBE'] },
  { code: 'ESP 330', name: 'Planning Theory and Practice I', subject: null, icon: 'book-open', programs: ['SBE'] },
  { code: 'ESP 340', name: 'Law of Contract and Tort', subject: null, icon: 'shield', programs: ['SBE'] },
  { code: 'ESP 400', name: 'Regional Planning Studio', subject: null, icon: 'pen', programs: ['SBE'] },
  { code: 'ESP 410', name: 'Theories of Regional Planning and Development', subject: null, icon: 'book-open', programs: ['SBE'] },
  { code: 'ESP 420', name: 'Land Development and Investment', subject: null, icon: 'wallet', programs: ['SBE'] },
  { code: 'ESP 430', name: 'Planning Theory and Practice II', subject: null, icon: 'book-open', programs: ['SBE'] },
  { code: 'ESP 440', name: 'Geographic Information Systems', subject: null, icon: 'globe', programs: ['SBE'] },
  { code: 'ESP 450', name: 'Infrastructure Planning', subject: null, icon: 'layers', programs: ['SBE'] },
  { code: 'ESP 461', name: 'Research Methodology (Planning)', subject: null, icon: 'book-open', programs: ['SBE'] },
  { code: 'ESP 500', name: 'Thesis Project (Urban and Regional Planning)', subject: null, icon: 'file-text', programs: ['SBE'] },
  { code: 'ESP 510', name: 'Housing Economics and Policies (Planning)', subject: null, icon: 'home', programs: ['SBE'] },
  { code: 'ESP 520', name: 'Project Planning, Appraisal and Management', subject: null, icon: 'list-checks', programs: ['SBE'] },
  { code: 'ESP 530', name: 'Advanced Construction Technology (Planning)', subject: null, icon: 'ruler', programs: ['SBE'] },
  { code: 'ESP 540', name: 'Development Economics', subject: null, icon: 'chart', programs: ['SBE'] },
  { code: 'ESP 550', name: 'Introduction to Intellectual Property Rights (Planning)', subject: null, icon: 'shield', programs: ['SBE'] },
  { code: 'ESP 593', name: 'Practical Training (Urban and Regional Planning)', subject: null, icon: 'clipboard-check', programs: ['SBE'] },

  // ---- SBE — BSc Real Estate Studies ----
  { code: 'ESR 220', name: 'Land Economics', subject: null, icon: 'chart', programs: ['SBE'] },
  { code: 'ESR 240', name: 'Principles of Management', subject: null, icon: 'list-checks', programs: ['SBE'] },
  { code: 'ESR 250', name: 'Mathematics of Finance', subject: 'Mathematics', icon: 'calculator', programs: ['SBE'] },
  { code: 'ESR 253', name: 'Real Estate Information Systems', subject: null, icon: 'code', programs: ['SBE'] },
  { code: 'ESR 310', name: 'Business Finance', subject: null, icon: 'wallet', programs: ['SBE'] },
  { code: 'ESR 320', name: 'Development Economics (Real Estate)', subject: null, icon: 'chart', programs: ['SBE'] },
  { code: 'ESR 330', name: 'Quantitative Studies', subject: null, icon: 'chart', programs: ['SBE'] },
  { code: 'ESR 340', name: 'Law of Contract and Torts', subject: null, icon: 'shield', programs: ['SBE'] },
  { code: 'ESR 350', name: 'Principles of Valuation', subject: null, icon: 'calculator', programs: ['SBE'] },
  { code: 'ESR 410', name: 'Real Estate Finance and Taxation', subject: null, icon: 'wallet', programs: ['SBE'] },
  { code: 'ESR 420', name: 'Principles of Real Estate Investment and Development', subject: null, icon: 'home', programs: ['SBE'] },
  { code: 'ESR 430', name: 'Financial Accounting', subject: null, icon: 'calculator', programs: ['SBE'] },
  { code: 'ESR 440', name: 'Real Property Law — Principles', subject: null, icon: 'shield', programs: ['SBE'] },
  { code: 'ESR 450', name: 'Valuation Methodology', subject: null, icon: 'calculator', programs: ['SBE'] },
  { code: 'ESR 460', name: 'Introduction to Intellectual Property Rights (Real Estate)', subject: null, icon: 'shield', programs: ['SBE'] },
  { code: 'ESR 461', name: 'Research Methodology and Academic Reporting', subject: null, icon: 'book-open', programs: ['SBE'] },
  { code: 'ESR 500', name: 'Thesis Project (Real Estate Studies)', subject: null, icon: 'file-text', programs: ['SBE'] },
  { code: 'ESR 510', name: 'Housing Economics and Policies (Real Estate)', subject: null, icon: 'home', programs: ['SBE'] },
  { code: 'ESR 520', name: 'Land Policy and Development', subject: null, icon: 'globe', programs: ['SBE'] },
  { code: 'ESR 530', name: 'Real Estate Management', subject: null, icon: 'home', programs: ['SBE'] },
  { code: 'ESR 540', name: 'Real Property Law II — Applied Property Law', subject: null, icon: 'shield', programs: ['SBE'] },
  { code: 'ESR 550', name: 'Applied Valuation', subject: null, icon: 'calculator', programs: ['SBE'] },
  { code: 'ESR 593', name: 'Practical Training (Real Estate Studies)', subject: null, icon: 'clipboard-check', programs: ['SBE'] }
];

const VALID_PROGRAM_CODES = new Set(PROGRAM_CATALOG.map((p) => p.code));

// URL-safe slug for a course: MA110 -> ma110, E.D -> ed, "LA 111" -> la111.
function courseCodeToSlug(code) {
  return String(code || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

// Display label shown everywhere a program is named.
function programDisplayName(program) {
  if (!program) return '';
  return program.name || program.shortName || program.code;
}

// "MA110 — Mathematics"
function courseDisplay(course) {
  if (!course) return '';
  return `${course.code} — ${course.name}`;
}

// Serialize a program row (with optional counts) for API responses.
function serializeProgram(row, extra = {}) {
  if (!row) return null;
  return {
    code: row.code,
    name: row.name,
    shortName: row.short_name || row.name,
    groupName: row.group_name || null,
    icon: row.icon || 'book-open',
    description: row.description || '',
    ...extra
  };
}

function serializeCourse(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    slug: row.slug || courseCodeToSlug(row.code),
    icon: row.icon || 'book-open',
    subject: row.subject || null,
    ...extra
  };
}

// Idempotent seeding: insert any missing program/course/assignment rows.
// Safe to call on every boot — existing admin-managed data is never touched.
function seedProgramCatalog(db) {
  const insertProgram = db.prepare(`
    INSERT OR IGNORE INTO programs (code, name, short_name, group_name, icon, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  for (const p of PROGRAM_CATALOG) {
    insertProgram.run(p.code, p.name, p.shortName, p.groupName, p.icon, p.description, now);
  }

  const insertCourse = db.prepare(`
    INSERT OR IGNORE INTO courses (id, code, slug, name, icon, subject, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const c of COURSE_CATALOG) {
    insertCourse.run(`course-${courseCodeToSlug(c.code)}`, c.code, courseCodeToSlug(c.code), c.name, c.icon, c.subject, now);
  }

  const courseIdByCode = new Map(
    db.prepare('SELECT id, code FROM courses').all().map((r) => [r.code, r.id])
  );

  const link = db.prepare(`
    INSERT OR IGNORE INTO program_courses (program_code, course_id, sort_order)
    VALUES (?, ?, ?)
  `);
  // Courses are numbered in catalog order WITHIN each program, which is the
  // same convention the admin UI uses when it appends a course
  // (MAX(sort_order) + 1). Without this every single-program course would
  // land on sort_order 0 and the program would fall back to an alphabetical
  // sort — which for a large catalog like the School of the Built Environment
  // buries the shared first-year ES 1xx block under later-year courses.
  const nextOrderForProgram = new Map();
  for (const c of COURSE_CATALOG) {
    const courseId = courseIdByCode.get(c.code);
    if (!courseId) continue;
    for (const programCode of c.programs) {
      const order = nextOrderForProgram.get(programCode) || 0;
      link.run(programCode, courseId, order);
      nextOrderForProgram.set(programCode, order + 1);
    }
  }
}

module.exports = {
  PROGRAM_CATALOG,
  COURSE_CATALOG,
  VALID_PROGRAM_CODES,
  courseCodeToSlug,
  programDisplayName,
  courseDisplay,
  serializeProgram,
  serializeCourse,
  seedProgramCatalog
};
