<script>
  import { Button, Card, Divider } from "m3-svelte";

  let clicks = 0;

  function handleClick() {
    clicks += 1;
  }
</script>

<Card variant="elevated">
  <p>M3 Svelte</p>
  <h3>Buttons</h3>
  <p>
    This lazy panel renders several button variants from
    <code>m3-svelte</code>.
  </p>

  <Divider />

  <div>
    <Button onclick={handleClick}>Filled action</Button>
    <Button variant="tonal" onclick={handleClick}>Tonal action</Button>
    <Button variant="outlined" onclick={handleClick}>Outlined action</Button>
    <Button variant="text" onclick={handleClick}>Text action</Button>
  </div>

  <p>Lazy button clicks recorded: {clicks}</p>
</Card>
