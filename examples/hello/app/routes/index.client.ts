const root = document.querySelector<HTMLElement>("[data-beater-counter]");

if (root) {
  const button = root.querySelector<HTMLButtonElement>("[data-beater-increment]");
  const label = root.querySelector<HTMLElement>("[data-beater-count]");
  let count = Number(root.dataset.count ?? "0");

  const render = () => {
    root.dataset.state = "hydrated";
    root.dataset.count = String(count);
    if (button) {
      button.textContent = String(count);
      button.setAttribute("aria-label", `Client counter value ${count}`);
    }
    if (label) {
      label.textContent = `hydrated · ${count}`;
    }
  };

  button?.addEventListener("click", () => {
    count += 1;
    render();
  });

  render();
}
