import type { HTMLAttributes, ReactNode } from "react";
import styles from "./primitives.module.css";

type CardProps = HTMLAttributes<HTMLElement> & {
  as?: "article" | "div" | "section";
  children: ReactNode;
};

export function Card({ as: Component = "section", children, className, ...props }: CardProps) {
  return (
    <Component className={`${styles.card} ${className ?? ""}`.trim()} {...props}>
      {children}
    </Component>
  );
}
