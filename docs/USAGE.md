# PlayScout Automation — What It Does and How It Works 🚀

**PlayScout** is a test-discovery and organization dashboard for Playwright automation. Its core idea: point it at wherever your test files or test results live, and it automatically finds every test case, extracts its details, and lays it all out in a searchable, filterable table — without you writing any code or manually copying anything into a spreadsheet.

---

## 🔍 Module 1: Test Discovery (Scanning Engine)

This is where you bring test data in and analyze it. 

### 1. Import Methods
* **Local Folder:** Select or drag in a folder to recursively scan every subfolder for test files. You can also drag in individual files or a `.zip` archive (such as a "download all artifacts" CI bundle).
* **GitHub Repo:** Enter `owner/repo` to pull matching files directly from GitHub. Public repos require no setup; private repos work by entering a Personal Access Token (stored only in memory for the session).
* **Smart Import (AI):** Uses AI to parse non-standard formats (CSV exports, HTML reports, plain logs) and figure out the test structure. It shows the expected API calls before processing to avoid surprise costs.

### 2. Supported File Types
PlayScout automatically reads:
* Playwright spec files (`.spec.ts`, `.test.js`)
* JSON outputs (hand-written test lists, Playwright JSON reports, Mocha reports)
* JUnit XML (standard CI report format)
* Plain text outlines
* Playwright `.jsonl`/blob event logs (including `--reporter=blob` zip archives)

*Note: Automatically ignores `node_modules`, `.git`, `dist`, and irrelevant folders.*

### 3. Analytics & Dashboard
* **Metrics Header:** Tracks files scanned, total tests found, and live status breakdowns (**Passed / Failed / Flaky / Expected Fail / Skipped / Unrun**) in counts and percentages.
* **Run-Health Trends:** Visual chart plotting execution history over time. Supports file-specific filtering and timeline dragging.
* **Interactive Results Table:** Displays Test ID, Title, Steps, Priority, and Status. Features dynamic search, column sorting, priority/status filtering, and collapsible suite groupings.
* **Duplicate Detection:** Highlights warnings if two tests share the same ID.
* **Manual Editing & Overrides:** Click any test row or detail panel to correct priority/status manually; adjustments persist across future re-scans.
* **Exporting:** Export filtered/sorted views directly to **JSON** or **CSV**.

---

## 📚 Module 2: Test Case Library (Curated Workspace)

The **Library** is an independent space to organize the test cases you want to maintain long-term, separate from live source code scans.

### Features:
* **Custom Folders:** Create, rename, and delete folders to structure your test suites.
* **Flexible Ingestion:** Add tests manually, save individual tests from Discovery, or bulk-save filtered results (e.g., filter by *Failed* and click "Save All").
* **Auto-Sync:** Turning on auto-save updates existing entries rather than creating duplicates.
* **Management & Export:** Full search, editing, and deletion with dedicated **JSON** and **CSV** export options.

---

## 💾 Data Handling & Privacy

* **Local Storage:** All scanned data and library items save to your browser automatically—closing the tab restores your session without re-scanning.
* **Data Control:** Use "Clear All" for a fresh slate, or selectively remove tests from a single source.

---

## ⏳ Roadmap & Planned Features

The following modules are marked as **"Soon"** in the sidebar and are currently out of scope for the discovery phase:
* **Test Execution:** Triggering live test runs directly from the desktop interface.
* **Run History:** Dedicated logs for past execution runs.
* **Settings:** Custom application configurations.
