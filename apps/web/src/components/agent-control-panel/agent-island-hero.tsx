/** Transparent island centerpiece for the Agent control panel. */
export function AgentIslandHero() {
  return (
    <div className="relative z-0 -mt-5 flex h-[clamp(13rem,29vh,18.5rem)] items-center justify-center sm:-mt-8">
      <div className="absolute bottom-[8%] h-[22%] w-[62%] rounded-[50%] bg-[#62b9eb]/25 blur-3xl" />
      <img
        alt="Osfo island home"
        className="relative h-[150%] w-auto max-w-none translate-y-10 object-contain drop-shadow-[0_22px_22px_rgba(55,99,126,0.16)] sm:h-[155%] sm:translate-y-12"
        height={825}
        src="/osfo/agent-island.webp"
        width={1100}
      />
    </div>
  );
}
