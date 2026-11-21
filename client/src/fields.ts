// Re-export of the standalone actionFields shim (vendor/space-sdk/fields).
// The app imports actionFields from "./fields" so the client never
// depends on the Muse macro build.
export { actionFields } from "@hatch/space-sdk/fields";
export type { FieldProps } from "@hatch/space-sdk/fields";
