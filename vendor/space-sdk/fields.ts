// Standalone replacement for "@hatch/space-sdk/fields" (actionFields).
// In Muse this was a Bun macro that read the Zod request schemas at
// build time and produced {name, required, minLength, ...} props.
// The ViceSunshine client only ever SPREADS these props onto inputs
// ({...FIELDS.someAction.someField}) or passes them as fieldProps to
// RegionPicker, which also spreads them. A runtime Proxy that returns
// {name: <field>} for any action/field therefore behaves identically
// for every use in the app, without a build-time macro. Server-side
// validation is unchanged: the server still enforces the Zod schemas.
// The TYPES below are copied from the SDK so FIELDS is typed exactly
// as the app expects (mapped over the Actions' request shapes).
export type FieldProps = {
  name: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  step?: number | "any";
  type?: "email" | "url" | "number";
};

export type RequestFields<S> = S extends { shape: infer Shape }
  ? { readonly [F in keyof Shape]: RequestFields<Shape[F]> }
  : S extends { element: infer Item }
    ? RequestFields<Item>
    : S extends { unwrap(): infer Inner }
      ? RequestFields<Inner>
      : FieldProps;

type ActionRequestFields<A> = A extends { request: { shape: infer Shape } }
  ? { readonly [F in keyof Shape]: RequestFields<Shape[F]> }
  : Record<never, never>;

export type ActionFields<A> = {
  readonly [K in keyof A]: ActionRequestFields<A[K]>;
};

export function actionFields<A>(): ActionFields<A> {
  const field = (name: string): FieldProps => ({ name });
  const actionProxy = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        return field(prop);
      },
    },
  );
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        return actionProxy;
      },
    },
  ) as ActionFields<A>;
}
