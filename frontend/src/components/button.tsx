import type { ComponentProps } from "react";
import { buttonClass, type ButtonVariant } from "@/components/button-styles";

export function Button({
  variant = "primary",
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant }) {
  return <button type={type} className={buttonClass(variant, className)} {...props} />;
}
