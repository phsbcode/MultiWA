// MultiWA Admin - Integrations Page
// apps/admin/src/app/dashboard/integrations/page.tsx

'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/lib/api';

type TabKey = 'typebot' | 'chatwoot' | 'fastbots';

interface ProfileFastBots {
  profileId: string;
  displayName: string | null;
  phoneNumber: string | null;
  enabled: boolean;
  hasBotKey: boolean;
}

export default function IntegrationsPage() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<TabKey>('typebot');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  // TypeBot
  const [typebotUrl, setTypebotUrl] = useState('');
  const [typebotBotId, setTypebotBotId] = useState('');
  const [typebotEnabled, setTypebotEnabled] = useState(false);

  // Chatwoot
  const [chatwootUrl, setChatwootUrl] = useState('');
  const [chatwootToken, setChatwootToken] = useState('');
  const [chatwootAccountId, setChatwootAccountId] = useState('');
  const [chatwootInboxId, setChatwootInboxId] = useState('');
  const [chatwootEnabled, setChatwootEnabled] = useState(false);

  // FastBots
  const [fastbotsProfiles, setFastbotsProfiles] = useState<ProfileFastBots[]>([]);
  const [fastbotsSelectedProfile, setFastbotsSelectedProfile] = useState<string>('');
  const [fastbotsEnabled, setFastbotsEnabled] = useState(false);
  const [fastbotsBotKey, setFastbotsBotKey] = useState('');
  const [fastbotsHasKey, setFastbotsHasKey] = useState(false);
  const [fastbotsSaving, setFastbotsSaving] = useState(false);
  const [fastbotsTesting, setFastbotsTesting] = useState(false);
  const [fastbotsResetting, setFastbotsResetting] = useState(false);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const { data } = await api.getIntegrationConfig();
      if (data) {
        if (data.typebot) {
          setTypebotUrl(data.typebot.apiUrl || '');
          setTypebotBotId(data.typebot.defaultBotId || '');
          setTypebotEnabled(data.typebot.enabled);
        }
        if (data.chatwoot) {
          setChatwootUrl(data.chatwoot.url || '');
          setChatwootToken(data.chatwoot.apiToken || '');
          setChatwootAccountId(data.chatwoot.accountId || '');
          setChatwootInboxId(data.chatwoot.inboxId || '');
          setChatwootEnabled(data.chatwoot.enabled);
        }
      }
    } catch {
      // Config endpoint may not exist yet, that's OK
    }
    setLoading(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await api.saveIntegrationConfig({
        typebot: { apiUrl: typebotUrl, defaultBotId: typebotBotId, enabled: typebotEnabled },
        chatwoot: { url: chatwootUrl, apiToken: chatwootToken, accountId: chatwootAccountId, inboxId: chatwootInboxId, enabled: chatwootEnabled },
      });
      toast({
        title: '✅ Configuration Saved',
        description: res.data?.message || 'Integration configuration updated',
      });
    } catch {
      toast({ title: 'Error', description: 'Failed to save configuration', variant: 'destructive' });
    }
    setSaving(false);
  };

  const handleTest = async (type: Exclude<TabKey, 'fastbots'>) => {
    setTesting(type);
    try {
      const res = await api.testIntegration(type);
      if (res.data?.success) {
        toast({ title: '✅ Connection Successful', description: res.data.message });
      } else {
        toast({ title: '❌ Connection Failed', description: res.data?.message || 'Unknown error', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Error', description: `Failed to test ${type} connection`, variant: 'destructive' });
    }
    setTesting(null);
  };

  // ─── FastBots handlers ──────────────────────────────────────

  const loadFastbotsProfiles = async () => {
    try {
      const res = await api.getFastBotsConfigs();
      if (res.data?.data) {
        setFastbotsProfiles(res.data.data);
      }
    } catch {
      // API may not be ready yet
    }
  };

  const handleFastbotsProfileChange = async (profileId: string) => {
    setFastbotsSelectedProfile(profileId);
    if (!profileId) {
      setFastbotsEnabled(false);
      setFastbotsBotKey('');
      setFastbotsHasKey(false);
      return;
    }
    try {
      const res = await api.getFastBotsProfileConfig(profileId);
      if (res.data?.data) {
        setFastbotsEnabled(res.data.data.enabled);
        setFastbotsHasKey(res.data.data.hasBotKey);
        setFastbotsBotKey('');
      }
    } catch {
      setFastbotsEnabled(false);
      setFastbotsHasKey(false);
      setFastbotsBotKey('');
    }
  };

  const handleFastbotsSave = async () => {
    if (!fastbotsSelectedProfile) return;
    setFastbotsSaving(true);
    try {
      const updates: { enabled?: boolean; botApiKey?: string } = {
        enabled: fastbotsEnabled,
      };
      // Only send botApiKey if the user typed a new one
      if (fastbotsBotKey) {
        updates.botApiKey = fastbotsBotKey;
      }
      const res = await api.saveFastBotsConfig(fastbotsSelectedProfile, updates);
      if (res.data?.success) {
        toast({ title: '✅ FastBots Updated', description: res.data.message });
        setFastbotsBotKey('');
        setFastbotsHasKey(fastbotsHasKey || !!fastbotsBotKey);
        // Refresh profiles list
        loadFastbotsProfiles();
      } else {
        toast({ title: '❌ Error', description: res.data?.message || 'Failed to save', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to save FastBots configuration', variant: 'destructive' });
    }
    setFastbotsSaving(false);
  };

  const handleFastbotsTest = async () => {
    if (!fastbotsSelectedProfile) return;
    if (!fastbotsHasKey && !fastbotsBotKey) {
      toast({ title: '⚠️ Bot Key Required', description: 'Set a FastBots Bot API Key for this profile first.', variant: 'destructive' });
      return;
    }
    setFastbotsTesting(true);
    try {
      // The test endpoint reads the saved profile settings. Persist a newly
      // entered key first so testing the value in this form works as expected.
      if (fastbotsBotKey) {
        const saveRes = await api.saveFastBotsConfig(fastbotsSelectedProfile, {
          enabled: fastbotsEnabled,
          botApiKey: fastbotsBotKey,
        });
        if (!saveRes.data?.success) {
          throw new Error(saveRes.data?.message || 'Failed to save Bot API Key');
        }
        setFastbotsHasKey(true);
        setFastbotsBotKey('');
      }
      const res = await api.testFastBotsConnection(fastbotsSelectedProfile);
      if (res.data?.success) {
        toast({ title: '✅ FastBots Connected', description: res.data.message });
      } else {
        toast({ title: '❌ Connection Failed', description: res.data?.message || 'Unknown error', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to test FastBots connection', variant: 'destructive' });
    }
    setFastbotsTesting(false);
  };

  const handleFastbotsReset = async () => {
    if (!fastbotsSelectedProfile) return;
    setFastbotsResetting(true);
    try {
      const res = await api.resetFastBotsChats(fastbotsSelectedProfile);
      if (res.data?.success) {
        toast({ title: '🗑️ Chat History Reset', description: res.data.message });
      } else {
        toast({ title: '❌ Error', description: res.data?.message || 'Failed to reset', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to reset FastBots chat history', variant: 'destructive' });
    }
    setFastbotsResetting(false);
  };

  const tabs: { key: TabKey; label: string; icon: string; description: string }[] = [
    { key: 'typebot', label: 'TypeBot', icon: '🤖', description: 'Chatbot builder for automated conversations' },
    { key: 'chatwoot', label: 'Chatwoot', icon: '💬', description: 'Customer engagement & support platform' },
    { key: 'fastbots', label: 'FastBots AI', icon: '🧠', description: 'AI chatbot from FastBots.ai — per-profile toggle' },
  ];

  if (loading) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-secondary rounded-lg w-48" />
          <div className="h-4 bg-secondary rounded w-72" />
          <div className="flex gap-3">
            <div className="h-12 bg-secondary rounded-xl w-40" />
            <div className="h-12 bg-secondary rounded-xl w-40" />
            <div className="h-12 bg-secondary rounded-xl w-40" />
          </div>
          <div className="h-64 bg-secondary rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-3">
          <span className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white text-lg">🔌</span>
          Integrations
        </h1>
        <p className="text-muted-foreground mt-1">
          Connect third-party services to extend your WhatsApp gateway
        </p>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-3 flex-wrap">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => {
              setActiveTab(tab.key);
              if (tab.key === 'fastbots') loadFastbotsProfiles();
            }}
            className={`flex items-center gap-2.5 px-5 py-3 rounded-xl font-medium transition-all ${
              activeTab === tab.key
                ? 'bg-gradient-to-r from-purple-500/10 to-indigo-500/10 text-purple-700 dark:text-purple-300 border-2 border-purple-500/30 shadow-sm'
                : 'bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground border-2 border-transparent'
            }`}
          >
            <span className="text-xl">{tab.icon}</span>
            <div className="text-left">
              <div className="text-sm font-semibold">{tab.label}</div>
            </div>
          </button>
        ))}
      </div>

      {/* TypeBot Tab */}
      {activeTab === 'typebot' && (
        <div className="bg-card border border-border rounded-2xl overflow-hidden">
          <div className="p-6 border-b border-border bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/20 dark:to-indigo-950/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-3xl">🤖</span>
                <div>
                  <h3 className="text-lg font-bold text-foreground">TypeBot</h3>
                  <p className="text-sm text-muted-foreground">Build conversational chatbots with a visual flow builder</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${typebotEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                <span className={`text-sm font-medium ${typebotEnabled ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                  {typebotEnabled ? 'Connected' : 'Not Configured'}
                </span>
              </div>
            </div>
          </div>
          <div className="p-6 space-y-5">
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">API URL</label>
              <Input
                value={typebotUrl}
                onChange={e => setTypebotUrl(e.target.value)}
                placeholder="https://typebot.example.com"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">The URL of your TypeBot instance</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">Default Bot ID</label>
              <Input
                value={typebotBotId}
                onChange={e => setTypebotBotId(e.target.value)}
                placeholder="my-chatbot-id"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">The TypeBot flow ID to use when starting conversations</p>
            </div>
            <div className="flex items-center justify-between py-3 px-4 bg-secondary/30 rounded-xl">
              <div>
                <p className="text-sm font-medium text-foreground">Enable TypeBot Integration</p>
                <p className="text-xs text-muted-foreground">Requires TYPEBOT_API_URL environment variable</p>
              </div>
              <button
                onClick={() => setTypebotEnabled(!typebotEnabled)}
                className={`relative w-12 h-6 rounded-full transition-colors ${typebotEnabled ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${typebotEnabled ? 'translate-x-6' : ''}`} />
              </button>
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={handleSave} disabled={saving} className="bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700 text-white">
                {saving ? 'Saving...' : '💾 Save Configuration'}
              </Button>
              <Button variant="outline" onClick={() => handleTest('typebot')} disabled={testing === 'typebot' || !typebotUrl}>
                {testing === 'typebot' ? 'Testing...' : '🔗 Test Connection'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Chatwoot Tab */}
      {activeTab === 'chatwoot' && (
        <div className="bg-card border border-border rounded-2xl overflow-hidden">
          <div className="p-6 border-b border-border bg-gradient-to-r from-orange-50 to-amber-50 dark:from-orange-950/20 dark:to-amber-950/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-3xl">💬</span>
                <div>
                  <h3 className="text-lg font-bold text-foreground">Chatwoot</h3>
                  <p className="text-sm text-muted-foreground">Sync WhatsApp conversations with your Chatwoot helpdesk</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${chatwootEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                <span className={`text-sm font-medium ${chatwootEnabled ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                  {chatwootEnabled ? 'Connected' : 'Not Configured'}
                </span>
              </div>
            </div>
          </div>
          <div className="p-6 space-y-5">
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Chatwoot URL</label>
                <Input
                  value={chatwootUrl}
                  onChange={e => setChatwootUrl(e.target.value)}
                  placeholder="https://chatwoot.example.com"
                  className="font-mono text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">API Token</label>
                <Input
                  type="password"
                  value={chatwootToken}
                  onChange={e => setChatwootToken(e.target.value)}
                  placeholder="Your Chatwoot API access token"
                  className="font-mono text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Account ID</label>
                <Input
                  value={chatwootAccountId}
                  onChange={e => setChatwootAccountId(e.target.value)}
                  placeholder="1"
                  className="font-mono text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Inbox ID</label>
                <Input
                  value={chatwootInboxId}
                  onChange={e => setChatwootInboxId(e.target.value)}
                  placeholder="1"
                  className="font-mono text-sm"
                />
              </div>
            </div>
            <div className="flex items-center justify-between py-3 px-4 bg-secondary/30 rounded-xl">
              <div>
                <p className="text-sm font-medium text-foreground">Enable Chatwoot Integration</p>
                <p className="text-xs text-muted-foreground">Requires CHATWOOT_URL, CHATWOOT_API_TOKEN, and CHATWOOT_ACCOUNT_ID</p>
              </div>
              <button
                onClick={() => setChatwootEnabled(!chatwootEnabled)}
                className={`relative w-12 h-6 rounded-full transition-colors ${chatwootEnabled ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${chatwootEnabled ? 'translate-x-6' : ''}`} />
              </button>
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={handleSave} disabled={saving} className="bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 text-white">
                {saving ? 'Saving...' : '💾 Save Configuration'}
              </Button>
              <Button variant="outline" onClick={() => handleTest('chatwoot')} disabled={testing === 'chatwoot' || !chatwootUrl}>
                {testing === 'chatwoot' ? 'Testing...' : '🔗 Test Connection'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* FastBots AI Tab */}
      {activeTab === 'fastbots' && (
        <div className="bg-card border border-border rounded-2xl overflow-hidden">
          <div className="p-6 border-b border-border bg-gradient-to-r from-teal-50 to-emerald-50 dark:from-teal-950/20 dark:to-emerald-950/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-3xl">🧠</span>
                <div>
                  <h3 className="text-lg font-bold text-foreground">FastBots AI</h3>
                  <p className="text-sm text-muted-foreground">AI chatbot integration — configurable per WhatsApp profile</p>
                </div>
              </div>
            </div>
          </div>

          {fastbotsProfiles.length === 0 ? (
            <div className="p-6 text-center">
              <p className="text-muted-foreground">No WhatsApp profiles found. Create a profile first.</p>
              <Button
                variant="outline"
                onClick={loadFastbotsProfiles}
                className="mt-4"
              >
                🔄 Refresh
              </Button>
            </div>
          ) : (
            <div className="p-6 space-y-6">
              {/* Profile Overview Table */}
              <div>
                <h4 className="text-sm font-semibold text-foreground mb-3">Profile Status</h4>
                <div className="overflow-hidden rounded-xl border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-secondary/40">
                        <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Profile</th>
                        <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Phone</th>
                        <th className="text-center px-4 py-2.5 font-medium text-muted-foreground">Status</th>
                        <th className="text-center px-4 py-2.5 font-medium text-muted-foreground">Bot Key</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {fastbotsProfiles.map(p => (
                        <tr key={p.profileId} className="hover:bg-secondary/20">
                          <td className="px-4 py-2.5 font-medium text-foreground">
                            {p.displayName || p.phoneNumber || p.profileId.substring(0, 8)}
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground font-mono text-xs">
                            {p.phoneNumber || '—'}
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                              p.enabled ? 'text-emerald-600' : 'text-muted-foreground'
                            }`}>
                              <span className={`w-2 h-2 rounded-full ${p.enabled ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                              {p.enabled ? 'Active' : 'Disabled'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <span className={`inline-flex items-center text-xs ${
                              p.hasBotKey ? 'text-emerald-600' : 'text-muted-foreground'
                            }`}>
                              {p.hasBotKey ? '✓ Configured' : '— Not Set'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Profile Selector */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Select Profile to Configure</label>
                <select
                  value={fastbotsSelectedProfile}
                  onChange={e => handleFastbotsProfileChange(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border border-border bg-background text-foreground text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                >
                  <option value="">— Choose a profile —</option>
                  {fastbotsProfiles.map(p => (
                    <option key={p.profileId} value={p.profileId}>
                      {p.displayName || p.phoneNumber || p.profileId} {p.enabled ? '🟢' : '⚪'}
                    </option>
                  ))}
                </select>
              </div>

              {/* Configuration Card */}
              {fastbotsSelectedProfile && (
                <div className="space-y-5 p-5 bg-secondary/20 rounded-xl border border-border">
                  <h4 className="text-sm font-semibold text-foreground">Configuration</h4>

                  {/* Enable/Disable Toggle */}
                  <div className="flex items-center justify-between py-2">
                    <div>
                      <p className="text-sm font-medium text-foreground">Enable FastBots AI</p>
                      <p className="text-xs text-muted-foreground">
                        When enabled, incoming messages are sent to FastBots AI and the reply is sent automatically
                      </p>
                    </div>
                    <button
                      onClick={() => setFastbotsEnabled(!fastbotsEnabled)}
                      className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ${
                        fastbotsEnabled ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'
                      }`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${
                        fastbotsEnabled ? 'translate-x-6' : ''
                      }`} />
                    </button>
                  </div>

                  {/* Bot API Key */}
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-2">
                      FastBots Bot API Key
                    </label>
                    <Input
                      type="password"
                      value={fastbotsBotKey}
                      onChange={e => setFastbotsBotKey(e.target.value)}
                      placeholder={fastbotsHasKey ? '•••••••• (leave blank to keep current)' : 'Enter your FastBots bot API key'}
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Found in your FastBots bot Settings → Bot API Key (not the Account Integrations key)
                    </p>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex gap-3 pt-2 flex-wrap">
                    <Button
                      onClick={handleFastbotsSave}
                      disabled={fastbotsSaving}
                      className="bg-gradient-to-r from-teal-500 to-emerald-600 hover:from-teal-600 hover:to-emerald-700 text-white"
                    >
                      {fastbotsSaving ? 'Saving...' : '💾 Save Profile Config'}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleFastbotsTest}
                      disabled={fastbotsTesting || (!fastbotsHasKey && !fastbotsBotKey)}
                    >
                      {fastbotsTesting ? 'Testing...' : '🔗 Test Connection'}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleFastbotsReset}
                      disabled={fastbotsResetting}
                      className="border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30"
                    >
                      {fastbotsResetting ? 'Resetting...' : '🗑️ Reset Chat History'}
                    </Button>
                  </div>

                  {fastbotsHasKey && !fastbotsBotKey && (
                    <p className="text-xs text-muted-foreground italic">
                      A Bot API Key is already configured for this profile. Enter a new one only if you want to change it.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Info Banner */}
      <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4 text-sm text-blue-700 dark:text-blue-300 flex items-start gap-3">
        <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
        </svg>
        <div>
          <p className="font-medium mb-1">How FastBots AI works</p>
          <p>When enabled for a profile, incoming WhatsApp messages are sent to your FastBots.ai bot. The AI reply is sent back automatically from the same profile. Conversation continuity is maintained via chatId. To toggle per profile, use the profile selector above.</p>
        </div>
      </div>
    </div>
  );
}
