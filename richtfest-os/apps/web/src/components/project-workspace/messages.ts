import { registerMessages } from "../../i18n";
import en from "./locales/en.json";
import de from "./locales/de.json";

// Project-only strings load with the workspace, not the application boot bundle.
registerMessages({ en, de });
