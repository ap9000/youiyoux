import type { Meta, StoryObj } from "@storybook/react-vite";
import { ThemeProvider as NextThemes } from "next-themes";
import { ThemeProvider } from "@/components/theme-provider";
import { Button } from "./button";

const meta = {
  title: "UI/Button",
  component: Button,
  args: { children: "Button" },
  decorators: [
    (Story) => (
      <ThemeProvider theme="default">
        <Story />
      </ThemeProvider>
    ),
  ],
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {
  args: { children: "Publish" },
};

export const Outline: Story = {
  args: { variant: "outline", children: "Preview", onClick: () => {} },
};

export const Large: Story = {
  args: { size: "lg", children: "Get started" },
};

export const Default: Story = {};

export const Contrast: Story = {
  name: "High contrast",
  args: { children: "Publish" },
  decorators: [
    (Story) => (
      <ThemeProvider theme="contrast">
        <Story />
      </ThemeProvider>
    ),
  ],
};

export const SystemTheme: Story = {
  args: { variant: "ghost", children: "Follow system" },
  decorators: [
    (Story) => (
      <NextThemes attribute="class">
        <Story />
      </NextThemes>
    ),
  ],
};

export const WithIcon: Story = {
  render: (args) => (
    <Button {...args}>
      <span aria-hidden>+</span> New release
    </Button>
  ),
};

export const Legacy = () => <Button>Old style</Button>;
