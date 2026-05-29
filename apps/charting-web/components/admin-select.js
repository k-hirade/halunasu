"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import { Icon } from "./icon";

export function AdminSelect({
  value,
  onValueChange,
  options,
  ariaLabel,
  disabled = false,
  isSaving = false,
  placeholder = "選択",
  className = "",
  portalContainer = null
}) {
  const selectedOption = options.find((option) => option.value === value);
  const triggerClassName = ["admin-select-trigger", className].filter(Boolean).join(" ");

  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled || isSaving}>
      <SelectPrimitive.Trigger className={triggerClassName} aria-label={ariaLabel} title={selectedOption?.label || placeholder}>
        <span className="admin-select-value">
          <SelectPrimitive.Value aria-label={selectedOption?.label || placeholder}>
            <span className="admin-select-trigger-value">{selectedOption?.label || placeholder}</span>
          </SelectPrimitive.Value>
        </span>
        <SelectPrimitive.Icon asChild>
          <span className="admin-select-affordance" aria-hidden="true">
            {isSaving ? <span className="admin-select-spinner" /> : <span className="admin-select-chevron" />}
          </span>
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal container={portalContainer}>
        <SelectPrimitive.Content className="admin-select-content" position="popper" align="start" sideOffset={6}>
          <SelectPrimitive.Viewport className="admin-select-viewport">
            {options.map((option) => (
              <SelectPrimitive.Item
                className="admin-select-item"
                disabled={option.disabled}
                key={option.value}
                textValue={option.label}
                value={option.value}
              >
                <span className="admin-select-item-indicator">
                  <SelectPrimitive.ItemIndicator>
                    <Icon name="check" size={14} />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <span className="admin-select-item-copy">
                  <SelectPrimitive.ItemText>
                    <span className="admin-select-item-label">{option.label}</span>
                  </SelectPrimitive.ItemText>
                  {option.description ? <span className="admin-select-item-description">{option.description}</span> : null}
                </span>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
