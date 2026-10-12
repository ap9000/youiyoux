import "@fontsource/roboto/400.css";
import { Button, Dialog, DialogTitle, TextField } from "@mui/material";
import Tabs from "@mui/material/Tabs";

export function App() {
  return (
    <>
      <Tabs value={0} />
      <TextField label="Name" />
      <Button variant="contained">Save</Button>
      <Dialog open={false}>
        <DialogTitle>Hi</DialogTitle>
      </Dialog>
    </>
  );
}
