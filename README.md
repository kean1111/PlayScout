# PlayScout Automation ??

PlayScout Automation is a desktop application built to bridge the gap between automation code and observable quality metrics. It allows QA teams to import local folders, GitHub repositories, or use AI-powered smart imports to auto-discover E2E test cases, monitor run health over time, and manage a consolidated test case library.

PlayScout parses standard automation outputs (like Playwright JSON reports) to provide a single, unified view of your test suite's status.

---

## Key Features

### 1. Test Discovery & Observability
Automated scanning of folders or repositories to identify test spec files, plot historical data, and track test counts.
* **Run Health Over Time:** Visualize trends (Passed, Failed, Flaky, Expected Fail, Skipped) from historical execution runs using Trend Areas or Stacked Bars.
* **Repository Overview:** Live metrics including files scanned, tests found, and scanned sources.
* **Automated Parsing Standards:** Auto-detects tests matched by \	est()\ blocks, JSDoc annotations (tags), source mapping, and direct report imports (JSON, XML/JUnit reports).

### 2. Multi-Source Import
A powerful import engine designed for flexibility and complex test environments.
* **Local Folder:** Point PlayScout at any directory or drag-and-drop multiple folders/files (e.g., specific \eport.json\ files) for immediate analysis.
* **GitHub Repo (Coming Soon):** Seamlessly scan remote repositories.
* **Smart Import (AI):** Advanced parsing for non-standard formats, legacy reports, or unconventional test structures.

### 3. Test Library Management
A curated space to save, organize, and edit discovered test cases, completely independent of live scan results.
* **Folder Organization:** Move test cases into customizable folders (e.g., by suite, feature, or domain).
* **Search & Filter:** Instantly find test cases by ID, title, or tags.
* **Metadata Editing:** Modify test titles and other properties within the library without changing the source code.
* **Export Options:** Effortlessly export the curated library list to JSON or CSV for reporting.

### 4. Roadmap (Modules)
PlayScout is continuously evolving. Planned future modules include:
* **Test Execution:** Triggering test runs directly from the app.
* **Run History:** Dedicated view for deep-diving into historical results.
* **Settings & Custom Configurations.**

---

## Tech Stack

* **Platform:** Electron (Desktop Application)
* **Frontend:** JavaScript (ES6+), HTML5, CSS3
* **Core Backend:** Node.js
* **Data Processing:** Python (\extract.py\ for parsing tasks)

---

## Getting Started

### 1. Clone and Install
\\\ash
git clone https://github.com/kean1111/PlayScout.git
cd PlayScout
npm install
\\\

### 2. Run the Application
\\\ash
npm start
\\\

---

## License

This project is licensed under the [MIT License](LICENSE).
