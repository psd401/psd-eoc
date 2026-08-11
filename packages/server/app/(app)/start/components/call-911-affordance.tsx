export function Call911Affordance() {
  return (
    <aside className="call-911-affordance" aria-label="Emergency assistance">
      <span className="call-911-affordance__icon" aria-hidden="true">
        911
      </span>
      <div>
        <a className="call-911-affordance__link" href="tel:911">
          Call 911
        </a>
        <p className="call-911-affordance__text">
          Call 911 first. PSD EOC notifies staff; it does not contact 911.
        </p>
      </div>
    </aside>
  );
}
