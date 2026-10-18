import { registerMessages } from "../../i18n";
import en from "./locales/en.json";
import de from "./locales/de.json";

// Feasibility strings travel with the project workspace chunk instead of the boot bundle.
registerMessages({ en, de });
