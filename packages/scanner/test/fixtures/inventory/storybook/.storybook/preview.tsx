import type { Preview } from "@storybook/react-vite";
import "../src/app/globals.css";

const preview: Preview = {
  decorators: [(Story) => (
    <div className="p-6">
      <Story />
    </div>
  )],
};

export default preview;
