MSP Course & Lab Selector / Planner

This repository contains a web-based MSP course and lab planner that lets students select courses and automatically see compatible labs (that do not overlap in day/time). 
It is a lightweight, interactive version of the original Excel course/lab selector and has evolved into a more advanced single-page academic planning tool.

🧩 Features
Select Courses & Labs: Choose one or two courses and automatically see compatible labs in real-time.
Interactive Course Catalogue: Search and filter through the full MSP course offering using specialized “Filter Chips” (e.g., by Period, Discipline, or Level).
Academic Planning: Drag-and-drop or select courses to build a multi-year academic plan.
Transcript Integration: Upload official transcripts (PDF) to automatically mark completed courses using pdf.js.
Data Visualization: Visualize curriculum balance across different scientific disciplines.
Persistent Storage: Save your plan locally in the browser to continue later without losing progress.
Offline-first: Fully functional offline once the page and assets are loaded.

📂 Repository Structure
msp-course-lab-selector/
│
├── MSP Course Planner V4/                ← stable standalone version of app, with local fallback of data and images
│   ├── assets/
│   │   ├── favicon.png
│   │   ├── logo-header.png
│   │   ├── logo-main.png
│   │   ├── MSP Logo.png
│   │   └── UM Logo.png
│   ├── data/
│   │   ├── periods/
│   │   │   ├── P1.csv
│   │   │   ├── P2.csv
│   │   │   ├── P4.csv
│   │   │   └── P5.csv
│   │   ├── antireqs.json
│   │   ├── app_config.json
│   │   ├── bundles.json
│   │   ├── course_catalogue.json
│   │   ├── load_rules.json
│   │   └── MSP_Course_Descriptions.md
│   ├── planner-v4.html
│   └── version.json
│
├── README.md           ← This guide
└── LICENSE (optional)

⚙️ How to Use
1. Launch the App

Open planner-v2.html (or the dist/planner-v2.html stable version) in any modern web browser (Chrome, Firefox, Safari, Edge). No installation or server setup is required.

2. Exploring Courses
Navigate to the Catalogue section.
Use the search bar or filter chips to find courses in specific disciplines (Biology, Chemistry, Physics, etc.) or levels (1000, 2000, 3000).
3. Creating a Plan
Select courses to add to your planner.
The app automatically prevents scheduling conflicts and organizes courses by period and year.
4. Importing Your Transcript
Use the Transcript Upload section to import official transcripts.
The app scans the PDF and marks completed courses as “Completed.”
Internet is required only the first time to fetch the pdf.js library.
5. Selecting Labs
Compatible labs for the chosen courses are displayed dynamically.
Choose a lab from the dropdown or table to include it in your final selection.
Selected labs appear below the chosen courses.

🌐 Offline Capability
Catalogue & Planner: Works offline since all course data is embedded. *if schedule is updated Internet is required to pull the new data
Transcript Upload: Internet required only once to fetch pdf.js; cached afterwards.

For Developers
version.json priority field has 4 valid options: [low, medium, high, critical]


Plan saving and backups

The saving status above the main content shows when plans are saved in this browser. If saving fails, use Retry saving or Export backup. Saving is paused when an existing saved plan requires a newer app version or cannot be read, preserving that stored data.

Export backup downloads a JSON file containing P1, P2, P4 and P5 plans A–C, including study loads, external modules and bundles. Transcripts, starred courses and check acknowledgements are not included. Import backup validates the file and asks before replacing all plans. Review imported selections against the current schedule; unavailable modules may be removed.

Run persistence and backup checks with `node scripts/test-planner.cjs`.
