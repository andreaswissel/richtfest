import { z } from "zod";

/** Fire resistance of a wall or slab, weakest first: nichtbrennbar without a fire resistance, feuerhemmend, hochfeuerhemmend, hf auch unter mechanischer Beanspruchung, feuerbeständig, Bauart einer Brandwand (fb + nichtbrennbar + M). */
export const fireRatingSchema = z.enum(["nb", "fh", "hf", "hf_m", "fb", "fb_nb_m"]);
export type FireRating = z.infer<typeof fireRatingSchema>;
/** Door closures as drawn in a Brandschutzplan: dicht-, selbstschließend, vollwandig, rauchdicht, feuerhemmend (T 30) or feuerbeständig (T 90). */
export const fireClosureSchema = z.enum(["D", "DS", "V_DS", "RS", "T30_DS", "T30_RS", "T90_DS", "T90_RS"]);
export type FireClosure = z.infer<typeof fireClosureSchema>;
/** What a room is for escape: a notwendiger Treppenraum, a notwendiger Flur, an Aufenthaltsraum, or anything else. */
export const fireRoomRoleSchema = z.enum(["necessary_stairwell", "necessary_corridor", "habitable", "other"]);
export type FireRoomRole = z.infer<typeof fireRoomRoleSchema>;
/** Sonderbau types of § 50 Abs. 2 LBauO RLP, in its order. Hochhäuser follow from the height. */
export const fireSpecialUseSchema = z.enum(["none", "retail", "assembly", "office", "restaurant_hotel", "care", "childcare", "school_sports", "large_or_hazard", "commercial", "emissions", "temporary", "camping"]);
export type FireSpecialUse = z.infer<typeof fireSpecialUseSchema>;
export const garageEnclosureSchema = z.enum(["open", "closed"]);
/** How a notwendiger Treppenraum is vented (§ 34 Abs. 11): openable windows on every storey, or an opening at its highest point. */
export const stairwellSmokeVentSchema = z.enum(["windows", "top_opening"]);
export type StairwellSmokeVent = z.infer<typeof stairwellSmokeVentSchema>;
