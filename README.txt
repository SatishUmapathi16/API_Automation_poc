========================================================
        NEWMAN API AUTOMATION FRAMEWORK
                    README
========================================================

1. OVERVIEW
--------------------------------------------------------
This package contains a fully automated API testing
framework built using Postman, Newman, Node.js, and
PowerShell.

The framework is designed to:
- Execute multiple API test suites sequentially
- Validate functional correctness and SLA performance
- Generate professional HTML reports
- Provide consolidated executive summaries
- Maintain execution logs for traceability

No prior knowledge of Postman or automation is required
to run this package.


2. WHAT THIS FRAMEWORK DELIVERS
--------------------------------------------------------
- Automated execution of API test suites
- Pass / Fail metrics at API and test case level
- SLA (response time) validation
- Suite-level HTML reports
- One consolidated summary report
- Email-ready HTML reports
- Date-wise execution logs


3. PREREQUISITES (ONE-TIME SETUP)
--------------------------------------------------------

3.1 Operating System
- Windows 10 / Windows 11

3.2 Software Requirements

Node.js
- Version: 18 or higher
- Verify installation:
  node -v

Newman (Global Installation)
- Install using:
  npm install -g newman
- Verify:
  newman -v

PowerShell Execution Policy (Once)
- Open PowerShell (normal user) and run:
  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned


4. MANDATORY PATH CONFIGURATION (IMPORTANT)
--------------------------------------------------------

After extracting the ZIP, the user MUST update the
ROOT PATH inside the following files to match the local
directory where this project is placed.

Failure to update these paths will cause execution
errors or missing reports.

--------------------------------------------------------
FILES THAT REQUIRE PATH UPDATE
--------------------------------------------------------

1) run-all.ps1
   Variable to update:
   $root = "C:\Users\<YourUserName>\Documents\<ProjectFolder>"

2) scripts\cleanup-temp.js
   Variable to update:
   const DEFAULT_ROOT = "C:\\Users\\<YourUserName>\\Documents\\<ProjectFolder>";

3) scripts\combine-email-report.js
   Variable to update:
   const ROOT = "C:\\Users\\<YourUserName>\\Documents\\<ProjectFolder>";

4) scripts\make-suite-report.js
   Variable to update:
   const ROOT = "C:\\Users\\<YourUserName>\\Documents\\<ProjectFolder>";

--------------------------------------------------------
EXAMPLE
--------------------------------------------------------
If the project is extracted to:
C:\Automation\NewmanFramework

Then update all above paths to:
C:\Automation\NewmanFramework

--------------------------------------------------------


5. FOLDER STRUCTURE (HIGH LEVEL)
--------------------------------------------------------

Project Root
|
|-- run-all.ps1              Main execution script
|-- run-all.bat              Double-click runner
|-- my-script.txt            Suite configuration
|
|-- scripts\
|   |-- make-suite-report.js
|   |-- combine-email-report.js
|   |-- cleanup-temp.js
|
|-- Reports\
|   |-- YYYY-MM-DD\
|       |-- *.log            Execution logs
|
|-- Temp\                    Intermediate files
|
|-- EmailReports\
|   |-- YYYY-MM-DD\
|       |-- Digital Api Automation Report.html
|       |-- EmailBody.html
|       |-- EmailBody_Inline.html
|
|-- Suite folders containing:
    - Postman collection
    - Environment file
    - CSV / Excel test data


6. HOW TO EXECUTE
--------------------------------------------------------

OPTION A (RECOMMENDED):
- Double-click:
  run-all.bat

OPTION B (PowerShell):
- Open PowerShell in the project root folder
- Run:
  .\run-all.ps1

OPTION C (ALTERNATE RUNNER - BYPASS POLICY):
- Use this if script execution is blocked:
  powershell -ExecutionPolicy Bypass -File .\run-all.ps1

Execution runs automatically.
No manual intervention is required.


7. WHERE TO FIND REPORTS
--------------------------------------------------------

Final Consolidated Report:
EmailReports\YYYY-MM-DD\
Digital Api Automation Report.html

Suite-Level Reports:
<Suite>\Reports\YYYY-MM-DD\

Execution Logs:
Reports\YYYY-MM-DD\


8. REPORT HIGHLIGHTS
--------------------------------------------------------
- Executive KPI tiles (Pass %, APIs, Test Cases)
- Folder → API → Test Case drill-down
- SLA compliance metrics
- Soft failures highlighted (+ --> Failing)
- Expandable request and response evidence
- Printable and shareable HTML format


9. TEST DATA SUPPORT
--------------------------------------------------------
- CSV files are used directly
- Excel files (.xlsx / .xls) are auto-converted to CSV
- No manual data preparation required


10. SAFETY & COMPLIANCE
--------------------------------------------------------
- No API logic is modified
- No data is transmitted externally
- All execution is local
- Temp cleanup is scoped and safe
- Logs are preserved for audit purposes


11. CUSTOMIZATION (OPTIONAL)
--------------------------------------------------------
- Add or remove suites via my-script.txt
- Adjust SLA thresholds in configuration
- Update report titles without changing test logic


12. INTENDED AUDIENCE
--------------------------------------------------------
- Clients and stakeholders
- QA and Automation teams
- DevOps / CI users
- Release and UAT sign-off teams


13. SUPPORT
--------------------------------------------------------
If any issue occurs:
1. Confirm all ROOT paths are updated correctly
2. Review logs under Reports\YYYY-MM-DD
3. Ensure Node.js and Newman are installed correctly
4. Re-run the execution


========================================================
END OF DOCUMENT
========================================================
