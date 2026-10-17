// Public browser configuration only. NEVER put a service_role or secret key here.
// Copy values from Supabase > Project Settings > API after creating the project.
window.MSP_ADVISOR_CONFIG = {
  enabled: true, // Set to true ONLY after deploying the SQL schema and configuring auth.
  supabaseUrl: 'https://bppoalhfppstygqpqjuv.supabase.co',
  supabaseAnonKey: 'sb_publishable_UUkin8tQkFjcXGi3JJTQ_A__HOqYWz3', // Supabase publishable / anon key (safe to publish with RLS)
  loginMethod: 'password' // 'email' for pilot magic links; 'azure' after institutional setup.
};
