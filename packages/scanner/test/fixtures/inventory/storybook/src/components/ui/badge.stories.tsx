import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "./badge";

const meta: Meta<typeof Badge> = {
  component: Badge,
};

export default meta;

export const Neutral: StoryObj<typeof Badge> = {
  args: { children: "Draft" },
};

export const Success: StoryObj<typeof Badge> = {
  args: { ...Neutral.args, tone: "success", children: "Live" },
};
