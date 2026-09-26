/** Synthetic requests only. `null` marks an intentionally ambiguous intent. */
export const intentFixtures = [
	{ text: "Build a flashcard app with spaced repetition.", expected: "BUILD" },
	{ text: "Add a dark mode toggle to my portfolio website.", expected: "BUILD" },
	{ text: "Create a command line quiz game in Python.", expected: "BUILD" },
	{ text: "Implement pagination for the courses page.", expected: "BUILD" },
	{ text: "Give me a hint for solving this array problem, but let me write the answer.", expected: "TUTOR" },
	{ text: "Walk me through how to derive the loop invariant without giving the solution.", expected: "TUTOR" },
	{ text: "I'm stuck on recursion. Help me reason it out step by step.", expected: "TUTOR" },
	{ text: "Can we work through the algorithm together while I type it?", expected: "TUTOR" },
	{ text: "Explain what a closure is in JavaScript.", expected: "EXPLAIN" },
	{ text: "What is the difference between a promise and an async function?", expected: "EXPLAIN" },
	{ text: "Why does binary search have logarithmic time complexity?", expected: "EXPLAIN" },
	{ text: "Teach me how database indexes work with a small example.", expected: "EXPLAIN" },
	{ text: "My test fails with TypeError: cannot read properties of undefined. Help debug it.", expected: "DEBUG" },
	{ text: "The app crashes when I press Save. It should store the form, but returns 500.", expected: "DEBUG" },
	{ text: "Why is my sorting function returning the wrong order?", expected: "DEBUG" },
	{ text: "This script worked yesterday and now fails to connect. Find the bug.", expected: "DEBUG" },
	{ text: "Review my solution for correctness and edge cases.", expected: "CHECK" },
	{ text: "Check whether this React component meets the requirements.", expected: "CHECK" },
	{ text: "Look over my code and give feedback on readability.", expected: "CHECK" },
	{ text: "Inspect my tests for missing cases.", expected: "CHECK" },
	{ text: "Can you help with my project?", expected: null },
	{ text: "I need to understand and fix this code.", expected: null },
	{ text: "Could you check why the app is broken and then rebuild the page?", expected: null },
	{ text: "Let's continue.", expected: null },
] as const;

export interface SufficiencyFixture {
	id: string;
	text: string;
	intent: "BUILD" | "TUTOR" | "EXPLAIN" | "DEBUG" | "CHECK";
	enough: boolean;
	projectLanguages?: string[];
	projectFrameworks?: string[];
}

/** Hand-labeled for whether the assistant can take a useful next step now. */
export const sufficiencyFixtures: SufficiencyFixture[] = [
	{ id: "build-vague-website", text: "Build a website.", intent: "BUILD", enough: false },
	{ id: "build-detailed-quiz", text: "Add a quiz page in this React app. Show one multiple-choice question at a time, score answers immediately, and keep results in local state. Preserve the current navigation.", intent: "BUILD", enough: true },
	{ id: "debug-vague-broken", text: "My app is broken.", intent: "DEBUG", enough: false },
	{ id: "debug-complete-save", text: "The save button in my React form now returns HTTP 500. It should create a note; the browser console says POST /api/notes 500. This started after the API route rename.", intent: "DEBUG", enough: true },
	{ id: "explain-recursion", text: "Explain recursion.", intent: "EXPLAIN", enough: true },
	{ id: "check-vague", text: "Review this.", intent: "CHECK", enough: false },
	{ id: "tutor-detailed-binary-search", text: "Give me hints to solve binary search without showing code. I understand the loop but get stuck updating the lower bound when the midpoint is too small.", intent: "TUTOR", enough: true },
	{ id: "debug-vague-error", text: "Help me with the error.", intent: "DEBUG", enough: false },
	{ id: "debug-missing-expected", text: "The parser returns an empty array for my CSV file. Here is the call and the actual result, but I have not said what rows I expect.", intent: "DEBUG", enough: false },
	{ id: "debug-missing-actual", text: "The sign-in form should redirect to the dashboard after a valid login. Something is wrong, but I have no error or actual behavior to share yet.", intent: "DEBUG", enough: false },
	{ id: "debug-complete-test", text: "The sum test expects 7 for inputs 3 and 4, but gets 6. The failing assertion is in sum.test.ts after I changed the reducer initial value.", intent: "DEBUG", enough: true },
	{ id: "debug-complete-ui", text: "Clicking Delete should remove one item, but it removes the next item instead. I can reproduce this after sorting the list by name in the React page.", intent: "DEBUG", enough: true },
	{ id: "debug-missing-repro", text: "Sometimes the program fails. I don't know when or what message it gives.", intent: "DEBUG", enough: false },
	{ id: "debug-complete-runtime", text: "Running npm test fails with Cannot find module './math.js' from src/index.ts. The import was changed from ./math.ts yesterday; please investigate the module path.", intent: "DEBUG", enough: true },
	{ id: "build-vague-feature", text: "Add a feature to my app.", intent: "BUILD", enough: false },
	{ id: "build-detailed-search", text: "Add a client-side search field to the existing course list. Match course titles case-insensitively, update as I type, and show 'No courses found' when nothing matches.", intent: "BUILD", enough: true },
	{ id: "build-missing-language", text: "Write a function that parses dates for my assignment, but I haven't said which language or date format to use.", intent: "BUILD", enough: false },
	{ id: "build-stack-inferred", text: "Add a Reset button to the existing counter page. It should set the count to zero and keep the current styling.", intent: "BUILD", enough: true, projectLanguages: ["TypeScript"], projectFrameworks: ["React"] },
	{ id: "build-detailed-api", text: "In this Express project, add GET /api/tasks that returns the existing in-memory task array as JSON, sorted by creation time newest first. Return an empty array when there are no tasks.", intent: "BUILD", enough: true },
	{ id: "build-missing-outcome", text: "Use the existing database to improve the dashboard. I have not decided what the dashboard should display.", intent: "BUILD", enough: false },
	{ id: "build-constraints", text: "Implement a Python CLI that reads a local CSV of expenses, groups totals by category, and prints a table. Use the standard library only and leave the input file untouched.", intent: "BUILD", enough: true },
	{ id: "build-missing-framework", text: "Create a login page, but I haven't decided whether this is for the web app or the mobile app.", intent: "BUILD", enough: false },
	{ id: "explain-promises", text: "Explain JavaScript promises with one short example comparing then and await.", intent: "EXPLAIN", enough: true },
	{ id: "explain-indexes", text: "How does a database index speed up a lookup? Use a simple table example.", intent: "EXPLAIN", enough: true },
	{ id: "explain-no-topic", text: "Can you explain it to me?", intent: "EXPLAIN", enough: false },
	{ id: "explain-project-context", text: "Explain how useEffect cleanup works in the React project I'm editing.", intent: "EXPLAIN", enough: true, projectLanguages: ["TypeScript"], projectFrameworks: ["React"] },
	{ id: "tutor-step-by-step", text: "Help me reason through two-pointer search step by step. I can identify both ends, but I am unsure which pointer moves when the sum is too large. Please give hints, not code.", intent: "TUTOR", enough: true },
	{ id: "tutor-vague-stuck", text: "I'm stuck on the assignment.", intent: "TUTOR", enough: false },
	{ id: "tutor-collaborative", text: "Can we solve the palindrome exercise together? I want to write the code myself; start by asking how I would compare the first and last characters.", intent: "TUTOR", enough: true },
	{ id: "tutor-missing-problem", text: "Guide me through the problem without giving the answer, but I have not shared the problem statement yet.", intent: "TUTOR", enough: false },
	{ id: "check-detailed", text: "Review the sorting function in src/sort.ts for correctness on empty arrays, duplicates, and descending order. Focus on bugs rather than style.", intent: "CHECK", enough: true },
	{ id: "check-missing-target", text: "Please review my code for bugs, but I haven't identified a file or feature.", intent: "CHECK", enough: false },
	{ id: "check-project-inferred", text: "Check whether the current React form validates an email before submission and whether the error message is accessible.", intent: "CHECK", enough: true, projectLanguages: ["TypeScript"], projectFrameworks: ["React"] },
	{ id: "ambiguous-help", text: "I need help with my project.", intent: "BUILD", enough: false },
	{ id: "ambiguous-fix-or-explain", text: "Could you help me understand and fix this?", intent: "DEBUG", enough: false },
	{ id: "continuation-with-context", text: "Go ahead with the pagination plan we just agreed: ten items per page, Previous and Next controls, and keep filters when changing pages.", intent: "BUILD", enough: true },
];
