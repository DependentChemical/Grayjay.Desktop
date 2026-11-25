using Grayjay.Engine;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace Grayjay.Desktop.Tests.Plugins
{
    [TestClass]
    public class RumblePluginTests
    {


        [TestMethod]
        public void TestHome()
        {
            try
            {
                var plugin = GrayjayPlugin.FromUrl("https://plugins.grayjay.app/Rumble/RumbleConfig.json");
                plugin.Initialize();

                plugin.OnLog += (a, b) =>
                {
                    Console.WriteLine(b);
                };

                var home = plugin.GetHome();

                var results = home.GetResults();
                Assert.IsTrue(results.Length > 1);
                Assert.IsNotNull(results[0].Name);
                Assert.IsNotNull(results[0].Url);
                Assert.IsNotNull(results[1].Name);
                Assert.IsNotNull(results[1].Url);

                Console.WriteLine(JsonSerializer.Serialize(results));
            }
            catch (Exception ex) when (ex.GetType().Name.Contains("CaptchaRequired", StringComparison.OrdinalIgnoreCase) || ex.Message.Contains("Captcha", StringComparison.OrdinalIgnoreCase))
            {
                Assert.Inconclusive("Rumble captcha challenged in CI: " + ex.Message);
            }
        }

        [TestMethod]
        public void TestReplies()
        {
            try
            {
                var plugin = GrayjayPlugin.FromUrl("https://plugins.grayjay.app/Rumble/RumbleConfig.json");
                plugin.Initialize();

                plugin.OnLog += (a, b) =>
                {
                    Console.WriteLine(b);
                };

                var home = plugin.GetHome();

                var results = home.GetResults();
                Assert.IsTrue(results.Length > 1);

                var video = results.FirstOrDefault();

                var videoDetails = plugin.GetContentDetails(video.Url);

                var comments = plugin.GetComments(videoDetails.Url).GetResults();
                foreach (var comment in comments.Take(5))
                {
                    var replies = comment.GetReplies();
                    Assert.IsNotNull(replies);
                    if(replies.GetResults().Length > 0)
                    {
                        Console.WriteLine(JsonSerializer.Serialize(replies));
                        return;
                    }
                }
                throw new InvalidDataException("No replies found");
            }
            catch (Exception ex) when (ex.GetType().Name.Contains("CaptchaRequired", StringComparison.OrdinalIgnoreCase) || ex.Message.Contains("Captcha", StringComparison.OrdinalIgnoreCase))
            {
                Assert.Inconclusive("Rumble captcha challenged in CI: " + ex.Message);
            }
        }
    }
}
