import * as React from "react";

import { cn } from "@/lib/utils";

// rounded-2xl (no rounded-lg como el shadcn genérico): el layout de
// licitaciones usa el mismo lenguaje de tarjeta grande y redondeada que el
// panel principal y la sidebar de atiende-restaurantes.
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("rounded-2xl border border-border bg-card text-card-foreground shadow-card", className)} {...props} />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />,
);
CardHeader.displayName = "CardHeader";

export interface CardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  /**
   * Nivel semántico del encabezado (h1-h6). Antes estaba fijo a `<h3>` sin
   * forma de configurarlo: cualquier página con `SectionHeader` (h1) +
   * `Card` saltaba de h1 a h3 sin pasar por h2 (violación axe "moderate"
   * `heading-order`, W-07). Por defecto es 2 porque el caso normal es un
   * `Card` dentro de una página que ya tiene su propio `<h1>`.
   */
  level?: 1 | 2 | 3 | 4 | 5 | 6;
}

const CardTitle = React.forwardRef<HTMLParagraphElement, CardTitleProps>(
  ({ className, level = 2, ...props }, ref) => {
    const Heading = `h${level}` as const;
    return (
      <Heading
        ref={ref as React.Ref<HTMLHeadingElement>}
        className={cn("font-display text-xl font-semibold leading-none tracking-tight", className)}
        {...props}
      />
    );
  },
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => <p ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />,
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />,
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("flex items-center p-6 pt-0", className)} {...props} />,
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
